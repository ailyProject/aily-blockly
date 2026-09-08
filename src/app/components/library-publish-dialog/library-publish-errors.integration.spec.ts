import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { firstValueFrom } from 'rxjs';
import { CmdService, ElectronService, PlatformService } from '@core/platform/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { BlocklyLibraryPackageService, LibrarySubmissionService } from '@domain/dependencies/public-api';
import { API } from '../../configs/api.config';
import zhCn from '../../../../public/i18n/zh_cn/zh_cn.json';
import en from '../../../../public/i18n/en/en.json';
import { LibraryPublishDialogComponent, LibraryPublishDialogResult } from './library-publish-dialog.component';

describe('Library publishing simulated failures: HTTP service to rendered dialog', () => {
  let fixture: ComponentFixture<LibraryPublishDialogComponent>;
  let http: HttpTestingController;
  let readPackage: jasmine.Spy;
  let modal: { close: jasmine.Spy };
  let message: { error: jasmine.Spy; warning: jasmine.Spy };

  beforeEach(async () => {
    readPackage = jasmine.createSpy('readPackage').and.callFake(() => ({
      package: {
        packageJson: { name: '@aily-project/lib-test', version: '1.0.0', nickname: '测试库' },
        blockJson: [], toolboxJson: {}, generatorJs: '// generator',
        readme: 'README', readmeAi: 'AI README', i18n: {}, pinmaps: {},
      },
    }));
    modal = { close: jasmine.createSpy('close') };
    message = { error: jasmine.createSpy('error'), warning: jasmine.createSpy('warning') };
    await TestBed.configureTestingModule({
      imports: [LibraryPublishDialogComponent, TranslateModule.forRoot()],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations(),
        { provide: BlocklyLibraryPackageService, useValue: { readLibrarySubmissionPackageByRef: readPackage } },
        { provide: CmdService, useValue: {} },
        { provide: PlatformService, useValue: {} },
        { provide: ElectronService, useValue: {} },
        { provide: ConfigService, useValue: { libraryDict: {} } },
        { provide: NzMessageService, useValue: message },
        { provide: NzModalRef, useValue: modal },
        {
          provide: NZ_MODAL_DATA,
          useFactory: (service: LibrarySubmissionService) => ({
            ref: { name: '@aily-project/lib-test', path: '/simulated/library', source: 'declared' },
            submitPublish: async (result: LibraryPublishDialogResult) => {
              await firstValueFrom(service.submitLocalLibraryByRef(
                { name: '@aily-project/lib-test', path: '/simulated/library', source: 'declared' },
                false, result.packageJsonPatch, result.prDescription,
              ));
              return { success: true };
            },
          }),
          deps: [LibrarySubmissionService],
        },
      ],
    }).compileComponents();
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('zh_cn', zhCn);
    translate.setTranslation('en', en);
    translate.use('zh_cn');
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LibraryPublishDialogComponent);
    fixture.detectChanges();
    fixture.componentInstance.hardwareTestConfirmed = true;
    fixture.componentInstance.prDescription = '错误后保留的 PR 描述';
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => http.verify());

  function publish(): void {
    (fixture.nativeElement.querySelector('.footer button:last-child') as HTMLButtonElement).click();
    flushMicrotasks();
    fixture.detectChanges();
  }

  function expectFailure(reason: string): void {
    flushMicrotasks();
    fixture.detectChanges();
    const errors = fixture.nativeElement.querySelectorAll('[role="alert"]');
    expect(errors.length).toBe(1);
    expect(errors[0].textContent).toBe(`发布失败：${reason}`);
    expect(errors[0].textContent).not.toContain('[object Object]');
    expect(fixture.nativeElement.querySelectorAll('.ant-btn-loading').length).toBe(0);
    expect(fixture.nativeElement.querySelector('.footer button').disabled).toBeFalse();
    expect(fixture.componentInstance.packageName).toBe('@aily-project/lib-test');
    expect(fixture.componentInstance.prDescription).toBe('错误后保留的 PR 描述');
    expect(message.error).not.toHaveBeenCalled();
    expect(modal.close).not.toHaveBeenCalled();
  }

  const failures = [
    {
      name: '400 structured package validation error', status: 400,
      body: { detail: { errorCode: 'library_submission_invalid', message: 'readme.md cannot be empty' } },
      reason: 'readme.md cannot be empty (library_submission_invalid)',
    },
    {
      name: '401 Kong authentication envelope', status: 401,
      body: { status: 401, data: null, messages: 'Token expired', errorCode: 'AUTH_TOKEN_EXPIRED', errorArgs: {} },
      reason: 'Token expired (AUTH_TOKEN_EXPIRED)',
    },
    { name: '401 plain FastAPI detail', status: 401, body: { detail: 'Not authenticated' }, reason: 'Not authenticated (HTTP 401)' },
    {
      name: '403 GitHub request ID', status: 403,
      body: { detail: { errorCode: 'github_fork_branch_write_failed', message: 'Cannot write fork branch', errorArgs: { githubRequestId: 'REQ-403' } } },
      reason: 'Cannot write fork branch (github_fork_branch_write_failed; GitHub Request ID: REQ-403)',
    },
    {
      name: '409 GitHub fork conflict', status: 409,
      body: { detail: { errorCode: 'github_fork_unavailable', message: 'Repository already exists and is not the expected fork' } },
      reason: 'Repository already exists and is not the expected fork (github_fork_unavailable)',
    },
    {
      name: '422 validation array with field paths', status: 422,
      body: { detail: [
        { loc: ['body', 'package', 'packageJson', 'version'], msg: 'Field required', type: 'missing' },
        { loc: ['body', 'prDescription'], msg: 'String should have at most 2000 characters', type: 'string_too_long' },
      ] },
      reason: 'body.package.packageJson.version: Field required, body.prDescription: String should have at most 2000 characters (HTTP 422)',
    },
    { name: '429 readable rate limit', status: 429, body: { detail: 'Too many requests. Try again later.' }, reason: 'Too many requests. Try again later. (HTTP 429)' },
    { name: '500 empty response', status: 500, body: null, reason: `${zhCn.LIBRARY_PUBLISH.SERVICE_ERROR} (HTTP 500)` },
    { name: '502 HTML proxy response', status: 502, body: '<html><body>Bad Gateway</body></html>', reason: `${zhCn.LIBRARY_PUBLISH.SERVICE_ERROR} (HTTP 502)` },
    {
      name: 'HTTP 200 with failed business status', status: 200,
      body: { status: 400, errorCode: 'library_submission_invalid', errorMessage: '', messages: ['版本号不正确', '库名格式不正确'] },
      reason: '版本号不正确, 库名格式不正确 (library_submission_invalid)',
    },
    { name: 'HTTP 200 without a submission record', status: 200, body: { status: 200, data: null }, reason: `${zhCn.LIBRARY_PUBLISH.UNKNOWN_ERROR} (HTTP 200)` },
    { name: 'unrecognized error object', status: 400, body: { unexpected: { value: 1 } }, reason: `${zhCn.LIBRARY_PUBLISH.UNKNOWN_ERROR} (HTTP 400)` },
    { name: 'stringified object from an older server', status: 400, body: '[object Object]', reason: `${zhCn.LIBRARY_PUBLISH.UNKNOWN_ERROR} (HTTP 400)` },
  ];

  for (const failure of failures) {
    it(`renders one actionable error for ${failure.name}`, fakeAsync(() => {
      publish();
      const request = http.expectOne(API.librarySubmissions);
      expect(request.request.method).toBe('POST');
      expect(request.request.body.prDescription).toBe('错误后保留的 PR 描述');
      request.flush(failure.body, { status: failure.status, statusText: 'Simulated response' });
      expectFailure(failure.reason);
    }));
  }

  it('recovers from a network failure and a timeout before a successful user retry', fakeAsync(() => {
    for (const event of ['error', 'timeout']) {
      publish();
      expect(fixture.nativeElement.querySelectorAll('[role="alert"]').length).toBe(0);
      expect(fixture.nativeElement.querySelector('.footer button').disabled).toBeTrue();
      http.expectOne(API.librarySubmissions).error(new ProgressEvent(event));
      expectFailure(zhCn.LIBRARY_PUBLISH.NETWORK_ERROR);
    }

    publish();
    http.expectOne(API.librarySubmissions).flush({ status: 200, data: { id: 1, status: 'processing', pr_url: null } });
    flushMicrotasks();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
    expect(modal.close).toHaveBeenCalledOnceWith(jasmine.objectContaining({ result: 'success' }));
  }));

  it('renders synchronous local file errors without making an HTTP request', fakeAsync(() => {
    readPackage.and.throwError('读取 package.json 失败：文件已被移除');
    publish();
    http.expectNone(API.librarySubmissions);
    expectFailure('读取 package.json 失败：文件已被移除');
  }));

  it('uses the selected language for errors without a server description', fakeAsync(() => {
    TestBed.inject(TranslateService).use('en');
    publish();
    http.expectOne(API.librarySubmissions).error(new ProgressEvent('error'));
    flushMicrotasks();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent)
      .toBe(`Publishing failed: ${en.LIBRARY_PUBLISH.NETWORK_ERROR}`);
  }));

  it('renders error descriptions as text, never as HTML', fakeAsync(() => {
    const description = '<img src=x onerror="alert(1)"> invalid README';
    publish();
    http.expectOne(API.librarySubmissions).flush({ detail: description }, { status: 400, statusText: 'Bad Request' });
    expectFailure(`${description} (HTTP 400)`);
    expect(fixture.nativeElement.querySelector('[role="alert"] img')).toBeNull();
  }));
});
