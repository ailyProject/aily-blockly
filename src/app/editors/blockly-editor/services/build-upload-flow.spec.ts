import { fakeAsync, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ProcessState } from '@core/app-shell/public-api';
import { sha256Hex } from '../../../utils/crypto.utils';
import { _BuilderService } from './builder.service';
import { _UploaderService } from './uploader.service';

describe('Blockly compile and upload handoff', () => {
  let originalFs: any, originalPath: any, originalBuilder: any;
  beforeEach(() => {
    originalFs = window['fs']; originalPath = window['path']; originalBuilder = window['builder'];
  });
  afterEach(() => {
    window['fs'] = originalFs; window['path'] = originalPath; window['builder'] = originalBuilder;
  });

  function uploadFixture() {
    const events: string[] = [];
    const prepared = { code: 'compiled code', artifacts: [], projectMacros: [] };
    const project: any = { currentProjectPath: '/project', getBoardModule: async () => '@aily-project/board-test',
      isAilyCodeProject: () => false, getBoardJson: async () => ({}), getBuildPath: async () => '/project/.build' };
    const workflow: any = { currentState: ProcessState.IDLE,
      // Stop at the device boundary; these tests never flash hardware.
      startUpload: () => { events.push('upload'); return false; }, finishUpload() {} };
    const builder: any = Object.create(_BuilderService.prototype);
    Object.assign(builder, { projectService: project, passed: true, lastCode: prepared.code, currentProjectPath: '/project',
      preprocessRunGeneration: 0, workflowService: workflow,
      blocklyService: { workspace: {} },
      runWithInteractiveProjectCode: async (_workspace: unknown, consume: any) => consume(prepared, () => {}),
      build: jasmine.createSpy('build').and.callFake(async () => {
        events.push('build'); builder.passed = true; builder.lastCode = prepared.code;
        window['builder'].canReuseBlocklyUpload.and.returnValue(true); return {};
      }) });
    const uploader: any = Object.create(_UploaderService.prototype);
    Object.assign(uploader, { projectService: project, _builderService: builder,
      serialService: { currentPort: 'TEST-NO-DEVICE', currentPortInfo: { type: 'serial' } }, workflowService: workflow,
      translate: { instant: (text: string) => text }, noticeService: { update() {} }, message: { warning() {} },
      cmdService: { kill() {} }, hostBuilderService: { build: jasmine.createSpy('coderBuild').and.resolveTo({}) } });
    window['fs'] = { existsSync: () => true };
    window['builder'] = { canReuseBlocklyUpload: jasmine.createSpy('reuse').and.returnValue(true),
      publishArduinoGeneratedCode: jasmine.createSpy('publish').and.throwError('Upload checks must not publish files') };
    const run = () => uploader.upload().catch((error: any) => error);
    return { events, prepared, project, builder, uploader, run };
  }

  it('uploads unchanged successful firmware without compiling or publishing source', async () => {
    const f = uploadFixture(); await f.run();
    expect(f.events).toEqual(['upload']);
    expect(window['builder'].publishArduinoGeneratedCode).not.toHaveBeenCalled();
  });

  for (const changed of ['code', 'inputs-or-firmware', 'config-reset']) {
    it(`rebuilds before upload after ${changed}`, async () => {
      const f = uploadFixture();
      if (changed === 'code') f.prepared.code = 'new code';
      if (changed === 'inputs-or-firmware') window['builder'].canReuseBlocklyUpload.and.returnValue(false);
      if (changed === 'config-reset') f.builder.passed = false;
      await f.run(); expect(f.events).toEqual(['build', 'upload']);
    });
  }

  it('waits for running preprocessing without publishing into its workspace', fakeAsync(() => {
    const f = uploadFixture(); f.builder.preprocessProcess = {};
    void f.run(); tick(0);
    expect(f.builder.isUploading).toBeTrue(); expect(f.events).toEqual([]);
    tick(300); expect(f.events).toEqual([]);
    f.builder.preprocessProcess = null; tick(100);
    expect(f.events).toEqual(['upload']);
    expect(window['builder'].publishArduinoGeneratedCode).not.toHaveBeenCalled();
  }));

  for (const interrupted of ['cancelled', 'project-switched']) {
    it(`does not compile or upload when ${interrupted} during preprocess waiting`, fakeAsync(() => {
      const f = uploadFixture(); f.builder.preprocessProcess = {};
      void f.run(); tick(0);
      if (interrupted === 'cancelled') f.uploader.cancelled = true;
      else f.project.currentProjectPath = '/other';
      tick(100); expect(f.events).toEqual([]); expect(f.builder.isUploading).toBeFalse();
    }));
  }

  it('does not upload after a failed build and releases background scheduling', async () => {
    const f = uploadFixture(); f.builder.passed = false;
    f.builder.build.and.callFake(async () => { f.events.push('build'); throw new Error('compile failed'); });
    await f.run(); expect(f.events).toEqual(['build']); expect(f.builder.isUploading).toBeFalse();
  });

  it('stops upload when the workspace changes again during compilation', async () => {
    const f = uploadFixture(); f.builder.passed = false;
    f.builder.build.and.callFake(async () => {
      f.events.push('build'); f.builder.passed = true; f.prepared.code = 'edited during compile'; return {};
    });
    await f.run(); expect(f.events).toEqual(['build']); expect(f.builder.isUploading).toBeFalse();
  });

  it('preserves the Coder disk-build route', async () => {
    const f = uploadFixture(); f.project.isAilyCodeProject = () => true;
    await f.run(); expect(f.uploader.hostBuilderService.build).toHaveBeenCalledOnceWith('/project');
    expect(f.builder.build).not.toHaveBeenCalled(); expect(window['builder'].canReuseBlocklyUpload).not.toHaveBeenCalled();
  });

  function compileFixture() {
    const files = new Map([
      ['/project/package.json', JSON.stringify({ name: 'project', MACROS: [['WIDTH=240']] })],
      ['/project/node_modules/@aily-project/board-test/package.json', '{}'],
      ['/project/node_modules/@aily-project/board-test/board.json', '{"name":"board"}'],
    ]);
    window['fs'] = { readFileSync: (file: string) => files.get(file),
      replaceProjectText: async (request: any, check: () => void) => {
        check(); const file = `${request.projectPath}/${request.fileName}`;
        expect(`sha256:${await sha256Hex(files.get(file)!)}`).toBe(request.expectedHash);
        files.set(file, request.content);
        return { status: 'COMMITTED', hash: `sha256:${await sha256Hex(request.content)}` };
      } };
    window['path'] = { isExists: () => false, getAppDataPath: () => '/appdata', getAilyChildPath: () => '/child' };
    window['builder'] = { captureBuildSource: () => ({ digest: 'test' }) };
    const service: any = Object.create(_BuilderService.prototype), command = new Subject<any>();
    const prepared = { code: 'void setup() {}', artifacts: null, projectMacros: [{ name: 'WIDTH', value: 'WIDTH=320' }],
      revision: 1, sourceWorkspace: { documentText: '{}', revision: 1, runtimeRevision: 1, pageId: 'main' } };
    Object.assign(service, {
      passed: true, projectService: { currentProjectPath: '/project', currentPackageData: {},
        getBuildPath: async () => '/project/.build', getBoardModule: async () => '@aily-project/board-test',
        getRuntimeBoardModule: () => '@aily-project/board-test', getBoardJson: async () => ({ name: 'board' }) },
      workflowService: { startBuild: () => true, finishBuild: jasmine.createSpy('finishBuild') },
      electronService: { pathJoin: (...parts: string[]) => parts.join('/'), calculateHash: async () => 'hash' },
      platformService: { za7: '/tool' }, configService: { data: {} }, translate: { instant: (x: string) => x },
      blocklyService: { workspace: {}, isWorkspaceEditBlocked: () => false, getActivePageId: () => 'main',
        getProjectPersistenceRevision: () => 1, publishPreparedCodeView() {} },
      runWithInteractiveProjectCode: async (_workspace: unknown, consume: any) => consume(prepared, () => {}),
      waitForOneIdleBoundary: async () => {}, runBuilderPreprocessPhase: (_tag: string, fn: any) => fn(),
      waitForAilyBuilderReady: async () => {}, writeCompileRequest: jasmine.createSpy('request').and.resolveTo('/request'),
      cmdService: { spawn: jasmine.createSpy('spawn').and.returnValue(command) },
      noticeService: { update() {} }, logService: { update() {} }, message: { warning() {} },
      projectDebugConfigurationService: { updateWorkspaceGeneratedCode: async () => {} },
      compileValidationService: { triggerAfterSuccessfulCompile() {} },
      appendCompileLog() {}, saveBuildInfo: async () => {}, handleCompileError() {},
    });
    const start = async () => {
      const result = service.build().catch((error: any) => error);
      // Let asynchronous macro hashing/publication and request preparation finish.
      for (let n = 0; n < 100 && !service.cmdService.spawn.calls.count(); n++) {
        await new Promise(resolve => setTimeout(resolve, 1));
        if (service.workflowService.finishBuild.calls.count()) break;
      }
      return { result };
    };
    return { service, files, command, start };
  }

  it('publishes changed generator macros and reaches the compiler on the first build', async () => {
    const f = compileFixture(), { result } = await f.start();
    expect(f.service.cmdService.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.files.get('/project/package.json')!).MACROS).toEqual([['WIDTH=320']]);
    expect(f.service.writeCompileRequest.calls.mostRecent().args[0].projectMacros).toEqual([{ name: 'WIDTH', value: 'WIDTH=320' }]);
    f.command.next({ type: 'stdout', data: 'Sketch uses 123 bytes\n' });
    f.command.next({ type: 'close', code: 0 }); f.command.complete();
    expect((await result).state).toBe('done'); expect(f.service.passed).toBeTrue();
  });

  it('keeps real board/configuration drift guarded during generator preparation', async () => {
    const f = compileFixture();
    f.service.runWithInteractiveProjectCode = async (_workspace: unknown, consume: any) => {
      f.files.set('/project/package.json', '{"name":"changed-target"}');
      return consume({ code: 'new', artifacts: null, revision: 1 }, () => {});
    };
    const { result } = await f.start();
    expect((await result).text).toContain('BUILD_SOURCE_STALE'); expect(f.service.cmdService.spawn).not.toHaveBeenCalled();
  });

  it('guards macros again after publication while writing the compile request', async () => {
    const f = compileFixture();
    f.service.writeCompileRequest.and.callFake(async () => {
      const pkg = JSON.parse(f.files.get('/project/package.json')!); pkg.MACROS = [['WIDTH=480']];
      f.files.set('/project/package.json', JSON.stringify(pkg)); return '/request';
    });
    const { result } = await f.start();
    expect((await result).text).toContain('BUILD_SOURCE_STALE'); expect(f.service.cmdService.spawn).not.toHaveBeenCalled();
  });

  it('does not accept success-looking output followed by failed post-build validation', async () => {
    const f = compileFixture(), { result } = await f.start();
    f.command.next({ type: 'stdout', data: 'Sketch uses 123 bytes\n' });
    f.command.next({ type: 'close', code: 1 }); f.command.complete();
    expect((await result).state).toBe('error'); expect(f.service.passed).toBeFalse();
  });
});
