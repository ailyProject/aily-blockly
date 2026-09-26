import { NpmService } from './npm.service';
import { fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { ProjectService } from '@domain/project/public-api';

function attachProjectDependencies(service: any, projectPath = '/tmp/project') {
  const lifecycle = (Object.create(ProjectService.prototype) as any).dependencyLifecycle;
  const session = lifecycle.beginPreparation(projectPath);
  service.prjService = {
    ...service.prjService,
    getProjectDependencySession: (path = projectPath) => lifecycle.ensure(path),
    assertProjectDependencySession: (current: any) => lifecycle.assertCurrent(current),
    runProjectDependencyTask: (current: any, work: () => Promise<any>) => lifecycle.run(current, work),
  };
  return { lifecycle, session };
}

describe('NpmService shared dependency operations', () => {
  let oldPath: any, oldFs: any, oldFsp: any, oldIpc: any, oldNpm: any, service: any;
  beforeEach(() => {
    oldPath = window['path']; oldFs = window['fs']; oldNpm = window['npm'];
    oldFsp = window['fsp']; oldIpc = window['ipcRenderer'];
    window['path'] = { getAppDataPath: () => '/app', isExists: () => true,
      join: (...parts: string[]) => parts.join('/'), basename: (s: string) => s.split('/').pop(),
      resolve: (s: string) => s, relative: (root: string, target: string) => target.slice(root.length + 1),
      isAbsolute: (s: string) => s.startsWith('/') };
    window['fs'] = { existsSync: () => true, readFileSync: () => JSON.stringify({ version: '1.0.0', scripts: { uninstall: 'cleanup' } }) };
    window['npm'] = { run: jasmine.createSpy('npm').and.resolveTo() };
    service = Object.create(NpmService.prototype);
    service.cmdService = { runAsyncChecked: jasmine.createSpy('cmd').and.resolveTo() };
    service.application = { updateNotice: jasmine.createSpy('notice'), startInstall() {}, finishInstall() {} };
    service.translate = { instant: (s: string) => s };
    service.configService = { withBoardNpmRegistry: (cmd: string) => cmd, getNpmRegistryForProject: () => '' };
    service.traceToAppLog = () => {};
  });
  afterEach(() => {
    window['path'] = oldPath; window['fs'] = oldFs; window['npm'] = oldNpm;
    window['fsp'] = oldFsp; window['ipcRenderer'] = oldIpc;
  });

  it('runs board and package installs directly', async () => {
    await service.installBoard({ name: 'board-test', version: '1' });
    await service.installSDK({ name: 'sdk-test' });
    expect(window['npm'].run).toHaveBeenCalledOnceWith({ cmd: 'npm install board-test@1 --prefix "/app"' });
    expect(service.cmdService.runAsyncChecked).toHaveBeenCalledOnceWith(
      'npm install sdk-test --save-exact --prefix "/app"', '/app', true, false,
    );
  });

  it('runs the package cleanup script before npm uninstall', async () => {
    await service.uninstallSDK({ name: 'sdk-test' });
    expect(service.cmdService.runAsyncChecked.calls.allArgs()).toEqual([
      ['npm run uninstall', '/app/node_modules/sdk-test', true, false],
      ['npm uninstall sdk-test --prefix "/app"', '/app', true, false],
    ]);
  });

  it('repairs a missing extracted SDK without reinstalling its package', async () => {
    service.getPlatformPathBases = async () => ({ sdkBase: '/sdk', compilersBase: '/compiler', toolsBase: '/tools' });
    service.isPlatformPackageOnDisk = jasmine.createSpy('ready').and.returnValues(false, true);
    await service.installBoardDependencies({ boardDependencies: { '@aily-project/sdk-test': '1.0.0' } }, false, true);
    expect(service.cmdService.runAsyncChecked.calls.first().args[0]).toBe('npm run postinstall');
    expect(window['npm'].run).not.toHaveBeenCalled();
  });

  it('continues checking later dependencies after an installed dependency is skipped', async () => {
    service.getPlatformPathBases = async () => ({ sdkBase: '/sdk', compilersBase: '/compiler', toolsBase: '/tools' });
    service.isPlatformPackageOnDisk = jasmine.createSpy('ready').and.returnValues(true, false, true);
    await service.installBoardDependencies({ boardDependencies: {
      '@aily-project/sdk-ready': '1.0.0', '@aily-project/sdk-missing': '1.0.0',
    } }, false, true);
    expect(service.cmdService.runAsyncChecked).toHaveBeenCalledOnceWith(
      'npm run postinstall', '/app/node_modules/@aily-project/sdk-missing', true, false, undefined,
    );
    expect(window['npm'].run).not.toHaveBeenCalled();
  });

  it('does not fallback or install the next package after a cancelled postinstall', async () => {
    const { lifecycle, session } = attachProjectDependencies(service);
    service.getPlatformPathBases = async () => ({ sdkBase: '/sdk', compilersBase: '/compiler', toolsBase: '/tools' });
    service.isPlatformPackageOnDisk = () => false;
    let failPostinstall!: (error: Error) => void;
    service.cmdService.runAsyncChecked.and.returnValue(new Promise((_, reject) => { failPostinstall = reject; }));
    const install = service.installBoardDependencies({ boardDependencies: {
      '@aily-project/sdk-first': '1.0.0', '@aily-project/sdk-next': '1.0.0',
    } }, false, true, session);
    await Promise.resolve();
    expect(service.cmdService.runAsyncChecked).toHaveBeenCalledOnceWith(
      'npm run postinstall', '/app/node_modules/@aily-project/sdk-first', true, false, session,
    );
    lifecycle.cancel(session.projectPath);
    failPostinstall(new Error('command stopped'));
    await expectAsync(install).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_DEPENDENCY_CANCELLED' }));
    expect(window['npm'].run).not.toHaveBeenCalled();
    expect(service.application.updateNotice.calls.allArgs().some(([notice]: any[]) => notice.state === 'error')).toBeFalse();
  });

  it('scopes native npm and stops before the next package after cancellation', async () => {
    const { lifecycle, session } = attachProjectDependencies(service);
    window['path'].isExists = () => false;
    service.getPlatformPathBases = async () => ({ sdkBase: '/sdk', compilersBase: '/compiler', toolsBase: '/tools' });
    window['npm'].run.and.callFake(async () => { lifecycle.cancel(session.projectPath); });
    await expectAsync(service.installBoardDependencies({ boardDependencies: {
      '@aily-project/sdk-first': '1.0.0', '@aily-project/sdk-next': '1.0.0',
    } }, false, true, session)).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_DEPENDENCY_CANCELLED' }));
    expect(window['npm'].run).toHaveBeenCalledOnceWith({
      cmd: 'npm install @aily-project/sdk-first@1.0.0 --save-exact --prefix "/app"',
      projectPath: session.projectPath, projectSessionId: session.projectSessionId,
    });
    expect(service.application.updateNotice.calls.allArgs().some(([notice]: any[]) => notice.state === 'done')).toBeFalse();
  });

  it('reports an already installed package as complete without reinstalling it', async () => {
    await service.installSDK({ name: 'sdk-test', version: '1.0.0' });
    expect(service.cmdService.runAsyncChecked).not.toHaveBeenCalled();
    expect(service.application.updateNotice).toHaveBeenCalledOnceWith(jasmine.objectContaining({ state: 'done' }));
  });

  it('delegates resource removal to main instead of deleting in preload', async () => {
    let exists = true;
    window['fsp'] = { readdir: async (path: string) => path === '/app/sdk' && exists ? ['test'] : [], rm: jasmine.createSpy('unsafe') };
    window['ipcRenderer'] = { invoke: jasmine.createSpy('invoke').and.callFake(async (name: string, data: any) => {
      expect(name).toBe('appdata-resource-remove');
      expect(data).toEqual({ target: '/app/sdk/test' }); exists = false; return { ok: true };
    }) };
    service.getPlatformPathBases = async () => ({ sdkBase: '/app/sdk', compilersBase: '/app/tools', toolsBase: '/app/tools' });
    service.getDeclaredGlobalDependencyNames = () => [];
    service.syncGlobalDependencyUsage = () => ({ version: 2, dependencies: {}, resources: { 'sdk/test': 0 } });
    service.writeGlobalDependencyUsage = () => {};
    const result = await service.removeGlobalDependencies(null);
    expect(result.resourcePaths).toEqual(['/app/sdk/test']);
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledTimes(1); expect(window['fsp'].rm).not.toHaveBeenCalled();
  });
});

describe('NpmService global cleanup progress', () => {
  let originalApis: Record<string, any>;
  let service: any;
  let progress: number[];

  beforeEach(() => {
    originalApis = Object.fromEntries(['path', 'fsp', 'npm', 'ipcRenderer'].map(key => [key, window[key]]));
    const directories = { '/app/sdk': ['old-sdk'], '/app/tools': ['old-tool'] };
    window['path'] = {
      getAppDataPath: () => '/app',
      resolve: (path: string) => path,
      relative: (from: string, to: string) => to.slice(from.length + 1),
      isAbsolute: (path: string) => path.startsWith('/'),
      basename: (path: string) => path.split('/').pop(),
      join: (...paths: string[]) => paths.join('/'),
    };
    window['fsp'] = {
      readdir: async (path: string) => [...directories[path]],
      rm: jasmine.createSpy('rm').and.callFake(async (path: string) => {
        const base = path.slice(0, path.lastIndexOf('/'));
        directories[base] = directories[base].filter(name => !path.endsWith(`/${name}`));
      }),
    };
    window['npm'] = { run: jasmine.createSpy('run').and.resolveTo() };
    window['ipcRenderer'] = { invoke: jasmine.createSpy('remove').and.callFake(async (_channel: string, data: any) => {
      await window['fsp'].rm(data.target);
      return { ok: true };
    }) };
    service = Object.create(NpmService.prototype);
    Object.assign(service, {
      getPlatformPathBases: async () => ({ sdkBase: '/app/sdk', compilersBase: '/app/tools', toolsBase: '/app/tools' }),
      getDeclaredGlobalDependencyNames: jasmine.createSpy('getNames').and.returnValues(['@aily/sdk'], []),
      syncGlobalDependencyUsage: () => ({
        version: 2, dependencies: { '@aily/sdk': 1 }, resources: { 'sdk/old-sdk': 1, 'tools/old-tool': 1 },
      }),
      writeGlobalDependencyUsage: jasmine.createSpy('writeUsage'),
      runDeclaredUninstallScript: jasmine.createSpy('uninstallScript').and.resolveTo(),
    });
    progress = [];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalApis)) window[key] = value;
  });

  for (const days of [null, 30, 90]) {
    it(`reports completed work for ${days ?? 'all'} cleanup before reaching 100`, async () => {
      const result = await service.removeGlobalDependencies(days, (percent: number) => {
        if (percent === 100) expect(service.writeGlobalDependencyUsage).toHaveBeenCalledTimes(2);
        progress.push(percent);
      });
      expect(result.resourcePaths).toEqual(['/app/sdk/old-sdk', '/app/tools/old-tool']);
      expect(result.packageNames).toEqual(['@aily/sdk']);
      expect(progress[0]).toBe(0);
      expect(progress).toContain(60);
      expect(progress.at(-1)).toBe(100);
      expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBeTrue();
      expect(service.runDeclaredUninstallScript).toHaveBeenCalledBefore(window['npm'].run);
    });
  }

  it('does not report a failed resource deletion as completed work', async () => {
    window['fsp'].rm.and.rejectWith(new Error('resource is locked'));
    await expectAsync(service.removeGlobalDependencies(null, (value: number) => progress.push(value)))
      .toBeRejectedWithError('resource is locked');
    expect(progress.at(-1)).toBe(40);
    expect(window['npm'].run).not.toHaveBeenCalled();
  });
});

describe('NpmService Coder dependency sources', () => {
  function createService(coder = true, alreadyInstalled = false) {
    const service = Object.create(NpmService.prototype) as any;
    service.installedOk = jasmine.createSpy('installedOk').and.returnValues(
      Promise.resolve(alreadyInstalled), Promise.resolve(true),
    );
    service.isAilyCodeProjectRoot = jasmine.createSpy('isAilyCodeProjectRoot').and.returnValue(coder);
    service.cmdService = { runAsync: jasmine.createSpy('runAsync').and.resolveTo({ code: 0 }) };
    service.configService = { withProjectNpmRegistry: (command: string) => command };
    service.translate = { instant: (key: string) => key };
    service.application = {
      materializeCoderProjectLibraries: jasmine.createSpy('materializeCoderProjectLibraries').and.resolveTo(),
      updateNotice: jasmine.createSpy('updateNotice'),
    };
    attachProjectDependencies(service);
    // Keep notification ordering deterministic without leaving timers after the test.
    spyOn(window, 'setTimeout').and.callFake(((callback: () => void) => {
      callback();
      return 0;
    }) as any);
    return service;
  }

  it('waits for template source extraction after npm before reporting success', fakeAsync(() => {
    const service = createService();
    let finishSources!: () => void;
    service.application.materializeCoderProjectLibraries.and.returnValue(new Promise<void>(resolve => { finishSources = resolve; }));
    let ready: boolean | undefined;
    service.ensureProjectDependenciesInstalled('/tmp/coder-template').then((value: boolean) => { ready = value; });
    flushMicrotasks();
    expect(service.cmdService.runAsync).toHaveBeenCalledBefore(service.application.materializeCoderProjectLibraries);
    expect(service.application.materializeCoderProjectLibraries).toHaveBeenCalledOnceWith('/tmp/coder-template');
    expect(ready).toBeUndefined();
    expect(service.application.updateNotice.calls.allArgs().some(([notice]: any[]) => notice.state === 'done')).toBeFalse();
    finishSources();
    flushMicrotasks();
    expect(ready).toBeTrue();
    expect(service.application.updateNotice.calls.mostRecent().args[0].state).toBe('done');
  }));

  it('repairs npm-only Coder projects without rerunning npm', async () => {
    const service = createService(true, true);
    expect(await service.ensureProjectDependenciesInstalled('/tmp/coder-template')).toBeTrue();
    expect(service.cmdService.runAsync).not.toHaveBeenCalled();
    expect(service.application.materializeCoderProjectLibraries).toHaveBeenCalledOnceWith('/tmp/coder-template');
  });

  it('returns a retryable failure when source extraction fails', async () => {
    const service = createService();
    service.application.materializeCoderProjectLibraries.and.rejectWith(new Error('src.7z is invalid'));
    const onRetryInstall = jasmine.createSpy('retry');
    expect(await service.ensureProjectDependenciesInstalled('/tmp/coder-template', { onRetryInstall })).toBeFalse();
    expect(service.application.updateNotice.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
      state: 'error', detail: 'src.7z is invalid', sendToLog: true, onRetry: jasmine.any(Function),
    }));
    service.application.updateNotice.calls.mostRecent().args[0].onRetry();
    expect(onRetryInstall).toHaveBeenCalledTimes(1);
    expect(service.application.updateNotice.calls.allArgs().some(([notice]: any[]) => notice.state === 'done')).toBeFalse();
  });

  it('does not invoke the Coder runtime for Blockly dependency installs', async () => {
    const service = createService(false);
    expect(await service.ensureProjectDependenciesInstalled('/tmp/blockly-template')).toBeTrue();
    expect(service.cmdService.runAsync).toHaveBeenCalled();
    expect(service.application.materializeCoderProjectLibraries).not.toHaveBeenCalled();
  });

  it('invalidates delayed notices and retry callbacks when their project is cancelled', async () => {
    const service = createService();
    const { lifecycle, session } = attachProjectDependencies(service);
    const notices: Array<() => void> = [];
    (window.setTimeout as unknown as jasmine.Spy).and.callFake((callback: () => void) => { notices.push(callback); return 0; });
    service.application.materializeCoderProjectLibraries.and.rejectWith(new Error('source extraction failed'));
    const onRetryInstall = jasmine.createSpy('retry');
    expect(await service.ensureProjectDependenciesInstalled(session.projectPath, { onRetryInstall }, session)).toBeFalse();
    const retry = service.application.updateNotice.calls.mostRecent().args[0].onRetry;
    lifecycle.cancel(session.projectPath);
    service.application.updateNotice.calls.reset();
    notices.forEach(callback => callback());
    retry();
    expect(service.application.updateNotice).not.toHaveBeenCalled();
    expect(onRetryInstall).not.toHaveBeenCalled();
  });
});

describe('NpmService installBoardDeps', () => {
  function createService(boardPlatformDepsReady: boolean, coder = false) {
    const service = Object.create(NpmService.prototype) as any;
    const application = {
      currentProcessState: 'IDLE',
      startInstall: jasmine.createSpy('startInstall').and.callFake(() => {
        application.currentProcessState = 'INSTALLING';
        return true;
      }),
      finishInstall: jasmine.createSpy('finishInstall').and.callFake(() => {
        application.currentProcessState = 'IDLE';
      })
    };

    service.isInstalling = false;
    service.boardDepsInstallPromise = undefined;
    service.boardDependencyInstallProgress = undefined;
    service.prjService = {
      currentProjectPath: '/tmp/blockly-project',
      getBoardPackageJson: jasmine.createSpy('getBoardPackageJson').and.resolveTo({
        boardDependencies: { '@aily-project/sdk-test': '1.0.0' }
      }),
      getPackageJson: jasmine.createSpy('getPackageJson').and.resolveTo({})
    };
    service.application = application;
    service.areBoardPlatformDepsReady = jasmine.createSpy('areBoardPlatformDepsReady').and.resolveTo(boardPlatformDepsReady);
    service.isAilyCodeProjectRoot = jasmine.createSpy('isAilyCodeProjectRoot').and.returnValue(coder);
    service.recordGlobalDependencyUsage = jasmine.createSpy('recordGlobalDependencyUsage').and.resolveTo();
    service.installBoardDependencies = jasmine.createSpy('installBoardDependencies').and.resolveTo();
    attachProjectDependencies(service, service.prjService.currentProjectPath);

    return { service, application };
  }

  it('does not enter INSTALLING when the board platform is already ready', async () => {
    const { service, application } = createService(true);

    await service.installBoardDeps();

    expect(application.startInstall).not.toHaveBeenCalled();
    expect(application.finishInstall).not.toHaveBeenCalled();
    expect(service.installBoardDependencies).not.toHaveBeenCalled();
    expect(service.recordGlobalDependencyUsage).toHaveBeenCalledTimes(2);
    expect(service.isInstalling).toBeFalse();
  });

  it('enters INSTALLING only after the readiness check finds missing platform dependencies', async () => {
    const { service, application } = createService(false);

    await service.installBoardDeps();

    expect(service.areBoardPlatformDepsReady).toHaveBeenCalledBefore(application.startInstall);
    expect(application.startInstall).toHaveBeenCalledTimes(1);
    expect(service.installBoardDependencies).toHaveBeenCalledOnceWith(
      { boardDependencies: { '@aily-project/sdk-test': '1.0.0' } },
      false,
      true,
      service.prjService.getProjectDependencySession(),
    );
    expect(application.finishInstall).toHaveBeenCalledOnceWith(true);
    expect(service.isInstalling).toBeFalse();
  });

  it('keeps Coder ready without starting an install when its board dependencies are present', async () => {
    const { service, application } = createService(true, true);

    await service.installBoardDeps();

    expect(application.startInstall).not.toHaveBeenCalled();
    expect(service.installBoardDependencies).not.toHaveBeenCalled();
    expect(service.recordGlobalDependencyUsage).toHaveBeenCalledTimes(2);
    expect(service.isInstalling).toBeFalse();
  });

  it('installs missing Coder board dependencies through the shared installer', async () => {
    const { service, application } = createService(false, true);

    await service.installBoardDeps();

    expect(service.installBoardDependencies).toHaveBeenCalledOnceWith(
      { boardDependencies: { '@aily-project/sdk-test': '1.0.0' } }, false, true, service.prjService.getProjectDependencySession(),
    );
    expect(application.finishInstall).toHaveBeenCalledOnceWith(true);
  });

  it('waits through platform installation and its final refresh before reporting ready', fakeAsync(() => {
    const { service } = createService(false);
    const { lifecycle, session } = attachProjectDependencies(service);
    service.ensureProjectDependenciesInstalled = jasmine.createSpy('projectNpm').and.resolveTo(true);
    let finishPlatform!: () => void;
    service.installBoardDependencies.and.returnValue(new Promise<void>(resolve => { finishPlatform = resolve; }));
    const settled = jasmine.createSpy('settled');
    let ready = false;
    const task = service.ensureProjectAndBoardDeps(session.projectPath, { onBoardDepsSettled: settled }, session);
    task.then(() => { ready = true; });
    lifecycle.finishPreparation(session);
    flushMicrotasks();
    expect(lifecycle.isBusy(session.projectPath)).toBeTrue();
    expect(ready).toBeFalse();
    expect(settled).not.toHaveBeenCalled();
    finishPlatform();
    flushMicrotasks();
    expect(ready).toBeTrue();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(lifecycle.isBusy(session.projectPath)).toBeFalse();
  }));

  it('does not let an old installation finally clear the next session', fakeAsync(() => {
    const { service, application } = createService(false);
    const { lifecycle, session } = attachProjectDependencies(service);
    const finish: Array<() => void> = [];
    service.installBoardDependencies.and.callFake(() => new Promise<void>(resolve => { finish.push(resolve); }));
    const old = service.installBoardDeps(session);
    let cancelled = false;
    old.catch(() => { cancelled = true; });
    flushMicrotasks();
    lifecycle.cancel(session.projectPath);
    lifecycle.release(session);
    const next = lifecycle.beginPreparation(session.projectPath);
    let currentDone = false;
    service.installBoardDeps(next).then(() => { currentDone = true; });
    flushMicrotasks();
    const currentRecord = service.boardDepsInstallPromise;
    service.recordGlobalDependencyUsage.calls.reset();
    application.finishInstall.calls.reset();
    finish[0]();
    flushMicrotasks();
    expect(cancelled).toBeTrue();
    expect(service.boardDepsInstallPromise).toBe(currentRecord);
    expect(service.isInstalling).toBeTrue();
    expect(service.recordGlobalDependencyUsage).not.toHaveBeenCalled();
    expect(application.finishInstall).not.toHaveBeenCalled();
    finish[1]();
    flushMicrotasks();
    expect(service.boardDepsInstallPromise).toBeUndefined();
    expect(service.isInstalling).toBeFalse();
    expect(currentDone).toBeTrue();
  }));

  it('releases only the install state it acquired when cancellation settles', fakeAsync(() => {
    const { service, application } = createService(false);
    const { lifecycle, session } = attachProjectDependencies(service);
    let finish!: () => void;
    service.installBoardDependencies.and.returnValue(new Promise<void>(resolve => { finish = resolve; }));
    service.installBoardDeps(session).catch(() => {});
    flushMicrotasks();
    lifecycle.cancel(session.projectPath);
    finish();
    flushMicrotasks();
    expect(application.finishInstall).toHaveBeenCalledOnceWith(false);
    expect(service.isInstalling).toBeFalse();
  }));
});
