import { fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { ProjectService } from '@domain/project/public-api';
import { NpmService } from './npm.service';

describe('Coder dependency installation and recovery', () => {
  let npm: any;
  let project: any;
  let session: any;
  let lifecycle: any;
  let original: Record<string, any>;

  beforeEach(() => {
    original = { path: window['path'], fs: window['fs'], npm: window['npm'], ipcRenderer: window['ipcRenderer'] };
    window['path'] = { join: (...parts: string[]) => parts.join('/'), getAppDataPath: () => '/app', isExists: () => true,
      basename: (path: string) => path.split('/').pop() };
    window['fs'] = { readFileSync: () => JSON.stringify({ version: '1.0.0' }) };
    window['npm'] = { run: jasmine.createSpy('nativeNpm').and.resolveTo() };
    project = Object.create(ProjectService.prototype);
    project.isAilyCodeProject = () => true;
    project.translate = { instant: (key: string) => key };
    project.currentProjectPathSubject = { value: '/project' };
    project.getBoardModule = jasmine.createSpy('boardModule').and.resolveTo('@aily-project/board-test');
    project.getBoardPackageJson = jasmine.createSpy('boardPackage').and.resolveTo({
      boardDependencies: { '@aily-project/sdk-esp32': '1.0.0' },
    });
    project.getCoderProjectContext = jasmine.createSpy('projectContext').and.returnValue(project);
    project.syncCurrentBoardConfig = jasmine.createSpy('syncBoard').and.resolveTo(true);
    lifecycle = project.dependencyLifecycle;
    session = lifecycle.ensure('/project');
    npm = Object.create(NpmService.prototype);
    npm.prjService = project;
    npm.translate = project.translate;
    project.configService = { isCoderProduct: jasmine.createSpy('isCoderProduct').and.returnValue(true) };
    npm.configService = { ...project.configService, withProjectNpmRegistry: (cmd: string) => cmd, getNpmRegistryForProject: () => '' };
    npm.application = {
      updateNotice: jasmine.createSpy('notice'),
      materializeCoderProjectLibraries: jasmine.createSpy('sources').and.resolveTo(),
    };
    npm.installedOk = jasmine.createSpy('installed').and.resolveTo(true);
    npm.isAilyCodeProjectRoot = () => true;
    npm.installBoardDeps = jasmine.createSpy('platform').and.resolveTo();
    npm.cmdService = { runAsync: jasmine.createSpy('npm').and.resolveTo({ code: 0 }), runAsyncChecked: jasmine.createSpy('postinstall').and.resolveTo() };
    npm.traceToAppLog = () => {};
    npm.getPlatformPathBases = async () => ({ sdkBase: '/sdk', compilersBase: '/tools', toolsBase: '/tools' });
  });

  afterEach(() => Object.assign(window, original));

  it('keeps every build entry blocked through platform install, source preparation and refresh', fakeAsync(() => {
    let platformDone!: () => void;
    let sourcesDone!: () => void;
    let refreshDone!: () => void;
    npm.installBoardDeps.and.returnValue(new Promise<void>(resolve => { platformDone = resolve; }));
    npm.application.materializeCoderProjectLibraries.and.returnValue(new Promise<void>(resolve => { sourcesDone = resolve; }));
    const refresh = jasmine.createSpy('refresh').and.returnValue(new Promise<void>(resolve => { refreshDone = resolve; }));
    let ready: boolean | undefined;
    npm.ensureProjectAndBoardDeps('/project', { onBoardDepsSettled: refresh }, session).then((result: boolean) => { ready = result; });
    expect(project.getProjectDependencyBlockMessage('/project')).toBe('BLOCKLY_EDITOR.INSTALLING_DEPS');
    flushMicrotasks();
    expect(npm.application.materializeCoderProjectLibraries).not.toHaveBeenCalled();
    platformDone(); flushMicrotasks();
    expect(ready).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    sourcesDone(); flushMicrotasks();
    expect(ready).toBeUndefined();
    expect(lifecycle.getStatus('/project')).toBe('installing');
    expect(npm.application.updateNotice.calls.allArgs().some(([notice]: any[]) => notice.state === 'done')).toBeFalse();
    refreshDone(); flushMicrotasks();
    expect(ready).toBeTrue();
    expect(project.getProjectDependencyBlockMessage('/project')).toBeUndefined();
    expect(npm.application.updateNotice.calls.mostRecent().args[0].state).toBe('done');
  }));

  for (const failure of ['npm', 'platform', 'runtime']) {
    it(`retains ${failure} failure and retries the full workflow once for repeated clicks`, fakeAsync(() => {
      if (failure === 'npm') {
        npm.installedOk.and.resolveTo(false);
        npm.cmdService.runAsync.and.rejectWith(new Error('npm unavailable'));
      } else if (failure === 'platform') {
        npm.installBoardDeps.and.rejectWith(new Error('download failed'));
      } else {
        npm.application.materializeCoderProjectLibraries.and.rejectWith(new Error('Timed out while connecting to subapp Runtime: aily-coder-editor'));
      }
      let result: boolean | undefined;
      npm.ensureProjectAndBoardDeps('/project', undefined, session).then((value: boolean) => { result = value; });
      flushMicrotasks();
      expect(result).toBeFalse();
      expect(project.getProjectDependencyBlockMessage('/project')).toBe('NPM.DEPS_RETRY_REQUIRED');
      expect(project.getProjectDependencyBlockMessage('/other')).toBeUndefined();
      const notice = npm.application.updateNotice.calls.mostRecent().args[0];
      expect(notice.state).toBe('error');
      expect(notice.setTimeout).toBeUndefined();
      expect(notice.onRetry).toEqual(jasmine.any(Function));
      npm.installedOk.and.resolveTo(true);
      npm.cmdService.runAsync.and.resolveTo({ code: 0 });
      npm.installBoardDeps.calls.reset();
      npm.installBoardDeps.and.resolveTo();
      npm.application.materializeCoderProjectLibraries.and.resolveTo();
      notice.onRetry(); notice.onRetry(); notice.onRetry();
      expect(lifecycle.getStatus('/project')).toBe('installing');
      flushMicrotasks();
      expect(npm.installBoardDeps).toHaveBeenCalledTimes(1);
      expect(lifecycle.getStatus('/project')).toBe('ready');
      if (failure === 'npm') expect(npm.cmdService.runAsync).toHaveBeenCalledTimes(2);
    }));
  }

  it('does not call source preparation or report success after a nonzero npm exit with files present', async () => {
    npm.installedOk.and.returnValues(Promise.resolve(false), Promise.resolve(true));
    npm.cmdService.runAsync.and.resolveTo({ code: 1, stderr: 'postinstall failed' });
    expect(await npm.ensureProjectAndBoardDeps('/project', undefined, session)).toBeFalse();
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
    expect(npm.application.materializeCoderProjectLibraries).not.toHaveBeenCalled();
    expect(npm.application.updateNotice.calls.mostRecent().args[0].detail).toBe('postinstall failed');
  });

  it('does not retry a cancelled project or publish its late result into a replacement session', fakeAsync(() => {
    npm.installBoardDeps.and.rejectWith(new Error('download failed'));
    npm.ensureProjectAndBoardDeps('/project', undefined, session);
    flushMicrotasks();
    const retry = npm.application.updateNotice.calls.mostRecent().args[0].onRetry;
    lifecycle.cancel('/project'); lifecycle.release(session);
    lifecycle.ensure('/project');
    npm.installBoardDeps.calls.reset();
    retry(); flushMicrotasks();
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
    expect(lifecycle.getStatus('/project')).toBe('idle');
  }));

  it('preserves Blockly build admission while Coder records failed preparation', () => {
    lifecycle.setResult(session, false);
    project.isAilyCodeProject = () => false;
    expect(project.getProjectDependencyBlockMessage('/project')).toBeUndefined();
  });

  it('keeps Blockly software build admission unchanged even for a Coder project', () => {
    project.configService.isCoderProduct.and.returnValue(false);
    lifecycle.setResult(session, false);
    expect(project.getProjectDependencyBlockMessage('/project')).toBeUndefined();
    const preparing = lifecycle.beginPreparation('/project');
    expect(project.getProjectDependencyBlockMessage('/project')).toBeUndefined();
    lifecycle.finishPreparation(preparing);
  });

  it('keeps the original source-before-platform flow in Blockly software with a Coder project', async () => {
    project.configService.isCoderProduct.and.returnValue(false);
    const refresh = jasmine.createSpy('refresh');
    expect(await npm.ensureProjectAndBoardDeps('/project', { onBoardDepsSettled: refresh }, session)).toBeTrue();
    expect(npm.application.materializeCoderProjectLibraries).toHaveBeenCalledBefore(npm.installBoardDeps);
    expect(npm.installBoardDeps).toHaveBeenCalledOnceWith(session);
    expect(npm.installBoardDeps).toHaveBeenCalledBefore(refresh);
    expect(npm.application.updateNotice).not.toHaveBeenCalled();
    expect(lifecycle.getStatus('/project')).toBe('idle');
  });

  it('preserves Blockly software platform error propagation without recording a Coder failure', async () => {
    project.configService.isCoderProduct.and.returnValue(false);
    npm.installBoardDeps.and.rejectWith(new Error('download failed'));
    await expectAsync(npm.ensureProjectAndBoardDeps('/project', undefined, session)).toBeRejectedWithError('download failed');
    expect(lifecycle.getStatus('/project')).toBe('idle');
    expect(npm.application.updateNotice).not.toHaveBeenCalled();
  });

  it('does not remove existing SDK directories or rerun their postinstall in Blockly software', async () => {
    project.configService.isCoderProduct.and.returnValue(false);
    const files = new Set(['/sdk/esp32_1.0.0', '/app/node_modules/@aily-project/sdk-esp32/package.json']);
    window['path'].isExists = (path: string) => files.has(path);
    window['ipcRenderer'] = { invoke: jasmine.createSpy('remove') };
    npm.getPlatformPathBases = async () => ({ sdkBase: '/sdk', compilersBase: '/tools', toolsBase: '/tools' });
    await npm.installBoardDependencies({ boardDependencies: { '@aily-project/sdk-esp32': '1.0.0' } }, false, true, session);
    expect(window['ipcRenderer'].invoke).not.toHaveBeenCalled();
    expect(npm.cmdService.runAsyncChecked).not.toHaveBeenCalled();
    expect(window['npm'].run).not.toHaveBeenCalled();
    expect(npm.application.updateNotice.calls.mostRecent().args[0].state).toBe('done');
  });

  it('preserves Blockly software native-install completion without the new SDK metadata check', async () => {
    project.configService.isCoderProduct.and.returnValue(false);
    window['path'].isExists = () => false;
    npm.getPlatformPathBases = async () => ({ sdkBase: '/sdk', compilersBase: '/tools', toolsBase: '/tools' });
    await npm.installBoardDependencies({ boardDependencies: { '@aily-project/sdk-esp32': '3.3.1' } }, false, true, session);
    expect(window['npm'].run).toHaveBeenCalledTimes(1);
    expect(npm.application.updateNotice.calls.mostRecent().args[0].state).toBe('done');
  });

  it('rejects unknown readiness and offers a complete retry before admitting execution', fakeAsync(() => {
    let error: any;
    npm.assertCoderDependenciesReady('/project').catch((value: any) => { error = value; });
    flushMicrotasks();
    expect(error.state).toBe('warn');
    expect(lifecycle.getStatus('/project')).toBe('error');
    expect(npm.cmdService.runAsync).not.toHaveBeenCalled();
    const notice = npm.application.updateNotice.calls.mostRecent().args[0];
    notice.onRetry(); notice.onRetry();
    flushMicrotasks();
    expect(npm.installBoardDeps).toHaveBeenCalledTimes(1);
    expect(project.syncCurrentBoardConfig).toHaveBeenCalledOnceWith(session);
    expect(lifecycle.getStatus('/project')).toBe('ready');
    error = undefined;
    npm.assertCoderDependenciesReady('/project').catch((value: any) => { error = value; });
    flushMicrotasks();
    expect(error).toBeUndefined();
  }));

  for (const state of ['installing', 'error']) {
    it(`rejects execution during ${state} without overwriting the install notice`, async () => {
      if (state === 'installing') lifecycle.beginPreparation('/project');
      else lifecycle.setResult(session, false);
      await expectAsync(npm.assertCoderDependenciesReady('/project')).toBeRejected();
      expect(npm.installedOk).not.toHaveBeenCalled();
      expect(npm.application.updateNotice).not.toHaveBeenCalled();
    });
  }

  it('rechecks project dependencies on disk even after a successful installation', async () => {
    lifecycle.setResult(session, true);
    npm.installedOk.and.resolveTo(false);
    await expectAsync(npm.assertCoderDependenciesReady('/project')).toBeRejectedWithError('NPM.DEPS_RETRY_REQUIRED');
    expect(lifecycle.getStatus('/project')).toBe('error');
    expect(npm.application.updateNotice.calls.mostRecent().args[0].onRetry).toEqual(jasmine.any(Function));
    expect(window['npm'].run).not.toHaveBeenCalled();
  });

  for (const missing of ['package', 'version', 'boards.txt', 'tool-directory']) {
    it(`rejects execution when ${missing} becomes invalid after successful installation`, async () => {
      lifecycle.setResult(session, true);
      if (missing === 'package') window['path'].isExists = (path: string) => !path.includes('/app/node_modules/');
      if (missing === 'version') window['fs'].readFileSync = () => JSON.stringify({ version: '0.9.0' });
      if (missing === 'boards.txt') window['path'].isExists = (path: string) => !path.endsWith('/boards.txt');
      if (missing === 'tool-directory') {
        project.getBoardPackageJson.and.resolveTo({ boardDependencies: { '@aily-project/tool-ctags': '1.0.0' } });
        window['path'].isExists = (path: string) => !path.startsWith('/tools/');
      }
      await expectAsync(npm.assertCoderDependenciesReady('/project')).toBeRejectedWithError('NPM.DEPS_RETRY_REQUIRED');
      expect(lifecycle.getStatus('/project')).toBe('error');
      expect(npm.application.updateNotice.calls.mostRecent().args[0].detail).toBe('NPM.DEPENDENCY_INCOMPLETE');
      expect(window['npm'].run).not.toHaveBeenCalled();
    });
  }

  it('checks the requested project context rather than the currently displayed project', async () => {
    lifecycle.setResult(session, true);
    const target = { getBoardModule: jasmine.createSpy('targetBoard').and.resolveTo('target-board'),
      getBoardPackageJson: jasmine.createSpy('targetPackage').and.resolveTo({ boardDependencies: {} }) };
    project.getCoderProjectContext.and.returnValue(target);
    await npm.assertCoderDependenciesReady('/project');
    expect(project.getCoderProjectContext).toHaveBeenCalledOnceWith('/project');
    expect(target.getBoardPackageJson).toHaveBeenCalled();
    expect(project.getBoardPackageJson).not.toHaveBeenCalled();
  });

  it('rejects an install that starts during preflight without turning it into an installation failure', fakeAsync(() => {
    lifecycle.setResult(session, true);
    let checked!: (ready: boolean) => void;
    npm.installedOk.and.returnValue(new Promise<boolean>(resolve => { checked = resolve; }));
    let error: any;
    npm.assertCoderDependenciesReady('/project').catch((value: any) => { error = value; });
    lifecycle.beginPreparation('/project');
    checked(true); flushMicrotasks();
    expect(error.message).toBe('BLOCKLY_EDITOR.INSTALLING_DEPS');
    expect(lifecycle.getStatus('/project')).toBe('installing');
    expect(npm.application.updateNotice).not.toHaveBeenCalled();
  }));

  it('discards preflight results after project cancellation', fakeAsync(() => {
    lifecycle.setResult(session, true);
    let checked!: (ready: boolean) => void;
    npm.installedOk.and.returnValue(new Promise<boolean>(resolve => { checked = resolve; }));
    let error: any;
    npm.assertCoderDependenciesReady('/project').catch((value: any) => { error = value; });
    lifecycle.cancel('/project'); lifecycle.release(session);
    lifecycle.ensure('/project');
    checked(false); flushMicrotasks();
    expect(error.code).toBe('PROJECT_DEPENDENCY_CANCELLED');
    expect(lifecycle.getStatus('/project')).toBe('idle');
    expect(npm.application.updateNotice).not.toHaveBeenCalled();
  }));

  it('skips the Coder preflight in Blockly software even for a Coder project', async () => {
    project.configService.isCoderProduct.and.returnValue(false);
    npm.installedOk.and.resolveTo(false);
    await npm.assertCoderDependenciesReady('/project');
    expect(npm.installedOk).not.toHaveBeenCalled();
    expect(project.getBoardPackageJson).not.toHaveBeenCalled();
    expect(npm.application.updateNotice).not.toHaveBeenCalled();
  });

  it('rejects a partially extracted SDK and accepts it only with both Arduino metadata files', () => {
    const files = new Set(['/sdk/esp32_3.3.1']);
    window['path'].isExists = (path: string) => files.has(path);
    const bases = { sdkBase: '/sdk', compilersBase: '/tools', toolsBase: '/tools' };
    expect(npm.isPlatformPackageOnDisk('@aily-project/sdk-esp32', '3.3.1', bases)).toBeFalse();
    files.add('/sdk/esp32_3.3.1/boards.txt');
    expect(npm.isPlatformPackageOnDisk('@aily-project/sdk-esp32', '3.3.1', bases)).toBeFalse();
    files.add('/sdk/esp32_3.3.1/platform.txt');
    expect(npm.isPlatformPackageOnDisk('@aily-project/sdk-esp32', '3.3.1', bases)).toBeTrue();
  });

  it('does not report a successful npm install when the SDK extraction is still incomplete', async () => {
    window['path'].isExists = () => false;
    npm.getPlatformPathBases = async () => ({ sdkBase: '/sdk', compilersBase: '/tools', toolsBase: '/tools' });
    await expectAsync(npm.installBoardDependencies({ boardDependencies: { '@aily-project/sdk-esp32': '3.3.1' } }, false, true, session))
      .toBeRejectedWithError('NPM.DEPENDENCY_INCOMPLETE');
    expect(npm.application.updateNotice.calls.allArgs().some(([notice]: any[]) => notice.state === 'done')).toBeFalse();
  });

  it('repairs an incomplete SDK directory before rerunning postinstall', async () => {
    const sdk = '/sdk/esp32_1.0.0';
    const files = new Set([sdk, '/app/node_modules/@aily-project/sdk-esp32/package.json']);
    window['path'].isExists = (path: string) => files.has(path);
    window['ipcRenderer'] = { invoke: jasmine.createSpy('remove').and.callFake(async (channel: string, data: any) => {
      expect(channel).toBe('appdata-resource-remove');
      expect(data).toEqual({ target: sdk });
      files.delete(sdk);
      return { ok: true };
    }) };
    npm.getPlatformPathBases = async () => ({ sdkBase: '/sdk', compilersBase: '/tools', toolsBase: '/tools' });
    npm.cmdService.runAsyncChecked.and.callFake(async () => {
      expect(files.has(sdk)).toBeFalse();
      [sdk, `${sdk}/boards.txt`, `${sdk}/platform.txt`].forEach(path => files.add(path));
    });
    await npm.installBoardDependencies({ boardDependencies: { '@aily-project/sdk-esp32': '1.0.0' } }, false, true, session);
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledTimes(1);
    expect(npm.cmdService.runAsyncChecked).toHaveBeenCalledOnceWith('npm run postinstall', '/app/node_modules/@aily-project/sdk-esp32', true, false, session);
    expect(window['npm'].run).not.toHaveBeenCalled();
    expect(npm.application.updateNotice.calls.mostRecent().args[0].state).toBe('done');
    await npm.installBoardDependencies({ boardDependencies: { '@aily-project/sdk-esp32': '1.0.0' } }, false, true, session);
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledTimes(1);
  });
});
