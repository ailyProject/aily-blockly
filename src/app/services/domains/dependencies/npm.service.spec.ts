import { NpmService } from './npm.service';
import { fakeAsync, flushMicrotasks } from '@angular/core/testing';

describe('NpmService global writer handoff', () => {
  let oldPath: any, oldFs: any, oldFsp: any, oldIpc: any, oldNpm: any, service: any, active: boolean;
  beforeEach(() => {
    oldPath = window['path']; oldFs = window['fs']; oldNpm = window['npm']; active = false;
    oldFsp = window['fsp']; oldIpc = window['ipcRenderer'];
    window['path'] = { getAppDataPath: () => '/app', isExists: () => true,
      join: (...parts: string[]) => parts.join('/'), basename: (s: string) => s.split('/').pop(),
      resolve: (s: string) => s, relative: (root: string, target: string) => target.slice(root.length + 1),
      isAbsolute: (s: string) => s.startsWith('/') };
    window['fs'] = { existsSync: () => true, readFileSync: () => JSON.stringify({ version: '1.0.0', scripts: { uninstall: 'cleanup' } }) };
    window['npm'] = { run: jasmine.createSpy('npm').and.callFake(async (options: any) => {
      expect(active).toBeTrue(); expect(options.appDataResourceToken).toBe('writer');
    }) };
    service = Object.create(NpmService.prototype);
    service.appDataResourceLock = { runExclusive: jasmine.createSpy('exclusive').and.callFake(async (_label: string, task: any) => {
      expect(active).toBeFalse(); active = true;
      try { return await task('writer'); } finally { active = false; }
    }) };
    service.cmdService = { runAsyncChecked: jasmine.createSpy('cmd').and.callFake(async (...args: any[]) => {
      expect(active).toBeTrue(); expect(args[4]).toEqual({ appDataResourceToken: 'writer', appDataResourceMode: 'write' });
    }) };
    service.application = { updateNotice() {}, startInstall() {}, finishInstall() {} };
    service.translate = { instant: (s: string) => s };
    service.configService = { withBoardNpmRegistry: (cmd: string) => cmd, getNpmRegistryForProject: () => '' };
    service.traceToAppLog = () => {};
  });
  afterEach(() => {
    window['path'] = oldPath; window['fs'] = oldFs; window['npm'] = oldNpm;
    window['fsp'] = oldFsp; window['ipcRenderer'] = oldIpc;
  });

  it('passes the writer to board install and package install', async () => {
    await service.installBoard({ name: 'board-test', version: '1' });
    await service.installSDK({ name: 'sdk-test' });
    expect(window['npm'].run).toHaveBeenCalledTimes(1);
    expect(service.cmdService.runAsyncChecked).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup and npm uninstall in one writer scope', async () => {
    await service.uninstallSDK({ name: 'sdk-test' });
    expect(service.appDataResourceLock.runExclusive).toHaveBeenCalledTimes(1);
    expect(service.cmdService.runAsyncChecked.calls.allArgs().map((a: any[]) => a[0])).toEqual([
      'npm run uninstall', 'npm uninstall sdk-test --prefix "/app"',
    ]);
  });

  it('repairs a missing extracted SDK under a writer without nested acquisition', async () => {
    service.getPlatformPathBases = async () => ({ sdkBase: '/sdk', compilersBase: '/compiler', toolsBase: '/tools' });
    service.isPlatformPackageOnDisk = jasmine.createSpy('ready').and.returnValues(false, true);
    await service.installBoardDependencies({ boardDependencies: { '@aily-project/sdk-test': '1.0.0' } }, false, true);
    expect(service.cmdService.runAsyncChecked.calls.first().args[0]).toBe('npm run postinstall');
    expect(service.appDataResourceLock.runExclusive).toHaveBeenCalledTimes(1);
    expect(window['npm'].run).not.toHaveBeenCalled();
  });

  it('delegates resource removal to main with the same writer instead of deleting in preload', async () => {
    let exists = true;
    window['fsp'] = { readdir: async (path: string) => path === '/app/sdk' && exists ? ['test'] : [], rm: jasmine.createSpy('unsafe') };
    window['ipcRenderer'] = { invoke: jasmine.createSpy('invoke').and.callFake(async (name: string, data: any) => {
      expect(active).toBeTrue(); expect(name).toBe('appdata-resource-remove');
      expect(data).toEqual({ token: 'writer', target: '/app/sdk/test' }); exists = false; return { ok: true };
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
      appDataResourceLock: { runExclusive: (_key: string, task: () => Promise<any>) => task() },
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
      state: 'error', detail: 'src.7z is invalid', sendToLog: true, onRetry: onRetryInstall,
    }));
    expect(service.application.updateNotice.calls.allArgs().some(([notice]: any[]) => notice.state === 'done')).toBeFalse();
  });

  it('does not invoke the Coder runtime for Blockly dependency installs', async () => {
    const service = createService(false);
    expect(await service.ensureProjectDependenciesInstalled('/tmp/blockly-template')).toBeTrue();
    expect(service.cmdService.runAsync).toHaveBeenCalled();
    expect(service.application.materializeCoderProjectLibraries).not.toHaveBeenCalled();
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
      true
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
      { boardDependencies: { '@aily-project/sdk-test': '1.0.0' } }, false, true,
    );
    expect(application.finishInstall).toHaveBeenCalledOnceWith(true);
  });
});
