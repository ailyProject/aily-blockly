import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, of, throwError } from 'rxjs';
import { API } from '../../../configs/api.config';
import { LibrarySubmissionPayload, LibrarySubmissionResult, LibrarySubmissionService } from './library-submission.service';

describe('LibrarySubmissionService', () => {
  const originalFs = window['fs'];
  const originalPath = window['path'];
  const originalOs = window['os'];
  const payload: LibrarySubmissionPayload = {
    package: {
      packageJson: { name: '@aily-project/lib-test', version: '1.0.0' },
      blockJson: [],
      toolboxJson: [],
      generatorJs: '',
      readme: '',
      readmeAi: '',
      i18n: {},
      pinmaps: {},
    },
  };
  const submission: LibrarySubmissionResult = {
    id: 17,
    mode: 'create',
    package_name: '@aily-project/lib-test',
    package_slug: 'lib-test',
    target_dir: 'lib-test',
    branch: 'submission-17',
    pr_url: null,
    pr_number: null,
    status: 'processing',
  };
  let service: LibrarySubmissionService;
  let post: jasmine.Spy;
  let runAsync: jasmine.Spy;

  beforeEach(() => {
    post = jasmine.createSpy('post');
    runAsync = jasmine.createSpy('runAsync');
    window['fs'] = { readFileSync: jasmine.createSpy('readFileSync').and.returnValue(new Uint8Array([1])) } as any;
    service = new LibrarySubmissionService({ post } as any, {} as any, { runAsync } as any, { za7: '7z' } as any);
  });

  afterEach(() => {
    window['fs'] = originalFs;
    window['path'] = originalPath;
    window['os'] = originalOs;
  });

  for (const transport of ['json', 'multipart'] as const) {
    const submit = () => transport === 'json'
      ? service.submitJson(payload)
      : service.submitMultipart(payload, '/archive/src.7z');

    it(`accepts a processing submission with the successful ${transport} envelope`, async () => {
      const response = { status: 200, data: submission };
      post.and.returnValue(of(response));

      expect(await firstValueFrom(submit())).toBe(response);
      expect(post.calls.mostRecent().args[0]).toBe(API.librarySubmissions);
      const body = post.calls.mostRecent().args[1];
      if (transport === 'json') {
        expect(body).toBe(payload);
      } else {
        expect(body instanceof FormData).toBeTrue();
        expect(JSON.parse(body.get('payload'))).toEqual(payload);
        expect(body.get('src_archive').name).toBe('src.7z');
      }
    });

    it(`preserves the ${transport} HTTP conflict details and original response`, async () => {
      const error = new HttpErrorResponse({
        status: 409,
        error: {
          detail: {
            errorCode: 'library_submission_already_submitted',
            errorArgs: { package_name: submission.package_name },
            message: '当前已有待处理的提交',
            submission,
            same_content: true,
            submitted_by_current_user: true,
            conflict_type: 'current_user_submission',
          },
        },
      });
      post.and.returnValue(throwError(() => error));

      await expectAsync(firstValueFrom(submit())).toBeRejectedWith(jasmine.objectContaining({
        status: 409,
        raw: error,
        errorCode: 'library_submission_already_submitted',
        errorArgs: { package_name: submission.package_name },
        message: '当前已有待处理的提交',
        submission,
        sameContent: true,
        submittedByCurrentUser: true,
        conflictType: 'current_user_submission',
      }));
    });

    it(`rejects a failed business envelope received through ${transport}`, async () => {
      const response = { status: 403, errorCode: 'forbidden', messages: ['没有发布权限'] };
      post.and.returnValue(of(response));

      await expectAsync(firstValueFrom(submit())).toBeRejectedWith(jasmine.objectContaining({
        status: 403,
        raw: response,
        errorCode: 'forbidden',
        message: '没有发布权限',
      }));
    });
  }

  it('rejects a successful envelope without a submission record', async () => {
    const response = { status: 200 };
    post.and.returnValue(of(response));

    await expectAsync(firstValueFrom(service.submitJson(payload))).toBeRejectedWith(jasmine.objectContaining({
      status: 200,
      raw: response,
      message: '',
    }));
  });

  it('retains outer error codes and arguments when detail contains the message', async () => {
    const error = new HttpErrorResponse({
      status: 400,
      error: {
        errorCode: 'library_submission_invalid_package',
        errorArgs: { field: 'version' },
        detail: { message: '版本号无效' },
      },
    });
    post.and.returnValue(throwError(() => error));

    await expectAsync(firstValueFrom(service.submitJson(payload))).toBeRejectedWith(jasmine.objectContaining({
      errorCode: 'library_submission_invalid_package',
      errorArgs: { field: 'version' },
      message: '版本号无效',
    }));
  });

  it('cleans up the temporary archive directory once when the compressor rejects', async () => {
    const mkdirSync = jasmine.createSpy('mkdirSync');
    const rmSync = jasmine.createSpy('rmSync');
    window['fs'] = {
      statSync: () => ({ _isDirectory: true }),
      readDirSync: () => ['library.cpp'],
      mkdirSync,
      existsSync: () => true,
      rmSync,
    } as any;
    window['path'] = {
      join: (...parts: string[]) => parts.join('/'),
      dirname: () => '/library',
    } as any;
    window['os'] = { tmpdir: () => '/temp' } as any;
    runAsync.and.rejectWith(new Error('压缩进程启动失败'));

    await expectAsync(firstValueFrom(service.submitBundle({
      package: payload.package,
      srcDirectoryPath: '/library/src',
      srcArchiveOutputPath: '/library/src.7z',
    }))).toBeRejectedWithError('压缩进程启动失败');

    expect(mkdirSync).toHaveBeenCalledTimes(1);
    expect(rmSync).toHaveBeenCalledOnceWith(mkdirSync.calls.mostRecent().args[0], { recursive: true, force: true });
    expect(post).not.toHaveBeenCalled();
  });
});
