import { ProjectService } from './project.service';
import { ProjectLifecycleGate } from './project-lifecycle-gate';
import { AiOperationRegistryService } from '@integration/automation/public-api';

describe('board switch project persistence', () => {
  let oldPath: any, oldFs: any;
  const target = '@aily-project/board-new';
  beforeEach(() => {
    oldPath = window['path']; oldFs = window['fs'];
    window['path'] = { getAppDataPath: () => '/app', join: (...parts: string[]) => parts.join('/') };
    window['fs'] = { existsSync: () => true, writeFileSync: jasmine.createSpy('write'), readFileSync: () => JSON.stringify({
      board: 'New Board', dependencies: { [target]: '1', '@aily-project/lib-core': '1' },
    }) };
  });
  afterEach(() => { window['path'] = oldPath; window['fs'] = oldFs; });
  function fixture() {
    return {
      currentProjectPath: '/project', isBoardSwitchInProgress: false, boardSwitchReloadWaiter: null,
      isPackageJsonBoardWatcherActive: false,
      acquireProjectLifecycle: () => ({ token: Symbol(), release: () => {} }),
      platformService: { getPlatformSeparator: () => '/' },
      getPackageJson: async () => ({ name: 'user-project', devmode: 'arduino', dependencies: {
        '@aily-project/board-old': '1', '@aily-project/lib-user': '2',
      } }),
      isAilyCodeProject: () => false, normalizeAilyBoardPackageName: (name: string) => name,
      configService: { boardDict: { [target]: { name: target, mode: ['arduino'] } }, recordBoardUsage: () => {}, getNpmRegistryForBoard: () => 'registry' },
      save: jasmine.createSpy('save').and.resolveTo({ success: true }),
      message: { loading: () => {}, success: () => {}, error: () => {} }, translate: { instant: (key: string) => key },
      getBoardModule: async () => '@aily-project/board-old',
      buildNpmPackageSpec: (name: string) => name,
      application: { updateFooterState: () => {} },
      buildNpmInstallCommand: async () => 'install-board',
      appDataResourceLock: { runExclusive: async (_key: string, task: (token: string) => Promise<void>) => task('writer-token') },
      cmdService: { runAsyncChecked: jasmine.createSpy('npm').and.resolveTo() },
      finishBoardSwitchWithoutPackageWatcher: jasmine.createSpy('reload').and.resolveTo(),
      rejectBoardSwitchReload: () => {}, waitForBoardSwitchReload: jasmine.createSpy('waiter').and.resolveTo(),
    };
  }
  it('preserves user library dependencies and uses target template metadata in the same project', async () => {
    const service = fixture();
    await ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' });
    expect(service.cmdService.runAsyncChecked.calls.first().args).toEqual([
      'install-board', undefined, true, false, { appDataResourceToken: 'writer-token', appDataResourceMode: 'write' },
    ]);
    const [path, content] = window['fs'].writeFileSync.calls.mostRecent().args;
    expect(path).toBe('/project/package.json');
    const manifest = JSON.parse(content);
    expect(manifest.name).toBe('user-project'); expect(manifest.board).toBe('New Board');
    expect(manifest.dependencies).toEqual({ [target]: '1', '@aily-project/lib-core': '1', '@aily-project/lib-user': '2' });
    expect(service.finishBoardSwitchWithoutPackageWatcher).toHaveBeenCalledOnceWith('@aily-project/board-old', target, '/project');
  });
  it('aborts before installing into another project when selection changes during app-data install', async () => {
    const service = fixture();
    service.cmdService.runAsyncChecked.and.callFake(async () => { service.currentProjectPath = '/other'; });
    await expectAsync(ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' })).toBeRejected();
    expect(service.cmdService.runAsyncChecked).toHaveBeenCalledTimes(1);
    expect(window['fs'].writeFileSync).not.toHaveBeenCalled();
    expect(service.isBoardSwitchInProgress).toBeFalse();
  });
  it('native Coder switching retains the declared entry and user libraries without rewriting source', async () => {
    const service: any = fixture();
    window['path'].isExists = () => true;
    service.isAilyCodeProject = () => true;
    service.getPackageJson = async () => ({ name: 'coder-project', type: 'coder', entry: 'firmware/app.cpp',
      dependencies: { '@aily-project/board-old': '1', '@aily-project/lib-user': '2' } });
    for (const method of ['applyAilyCodeBoardToPackageManifest', 'filterAilyCodeUserPreservedDeps', 'normalizeAilyCodeBoardDepRange']) {
      service[method] = (ProjectService.prototype as any)[method];
    }
    await ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' });
    const writes = window['fs'].writeFileSync.calls.allArgs();
    expect(writes.length).toBe(1);
    expect(writes[0][0]).toBe('/project/package.json');
    const manifest = JSON.parse(writes[0][1]);
    expect(manifest.type).toBe('coder'); expect(manifest.entry).toBe('firmware/app.cpp');
    expect(manifest.dependencies[target]).toBe('^1');
    expect(manifest.dependencies['@aily-project/lib-user']).toBe('2');
    expect(manifest.dependencies['@aily-project/board-old']).toBeUndefined();
    expect(service.finishBoardSwitchWithoutPackageWatcher).toHaveBeenCalledTimes(1);
  });
  it('lets Coder switch to a board that only provides the shared template', async () => {
    const service: any = fixture();
    window['path'].isExists = (value: string) => value.endsWith('/template');
    window['fs'].readFileSync = jasmine.createSpy('read').and.returnValue(JSON.stringify({
      board: 'Shared Template Board', dependencies: { [target]: '1', '@aily-project/lib-core': '1' },
    }));
    service.isAilyCodeProject = () => true;
    service.getPackageJson = async () => ({ name: 'coder-project', type: 'coder', entry: 'src/main.cpp',
      dependencies: { '@aily-project/board-old': '1', '@aily-project/lib-user': '2' } });
    for (const method of ['applyAilyCodeBoardToPackageManifest', 'filterAilyCodeUserPreservedDeps', 'normalizeAilyCodeBoardDepRange']) {
      service[method] = (ProjectService.prototype as any)[method];
    }

    await ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' });

    expect(window['fs'].readFileSync).toHaveBeenCalledWith(
      '/app/node_modules/@aily-project/board-new/template/package.json',
      'utf8',
    );
    const manifest = JSON.parse(window['fs'].writeFileSync.calls.mostRecent().args[1]);
    expect(manifest.type).toBe('coder');
    expect(manifest.board).toBe('Shared Template Board');
    expect(manifest.dependencies[target]).toBe('^1');
    expect(manifest.dependencies['@aily-project/lib-user']).toBe('2');
    expect(service.finishBoardSwitchWithoutPackageWatcher).toHaveBeenCalledTimes(1);
  });
  it('does not require a source template when switching an existing Coder project', async () => {
    const service: any = fixture();
    window['path'].isExists = (value: string) => value.endsWith('/template_arduino');
    window['fs'].existsSync = (value: string) => !value.endsWith('/project.aci');
    service.isAilyCodeProject = () => true;
    service.getPackageJson = async () => ({ name: 'coder-project', type: 'coder', entry: 'firmware/app.cpp',
      dependencies: { '@aily-project/board-old': '1' } });
    for (const method of ['applyAilyCodeBoardToPackageManifest', 'filterAilyCodeUserPreservedDeps', 'normalizeAilyCodeBoardDepRange']) {
      service[method] = (ProjectService.prototype as any)[method];
    }

    await ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' });

    const writes = window['fs'].writeFileSync.calls.allArgs();
    expect(writes.length).toBe(1);
    expect(JSON.parse(writes[0][1]).entry).toBe('firmware/app.cpp');
  });
  it('replaces only receipted Coder template libraries while retaining user additions and version overrides', async () => {
    const service: any = fixture();
    window['path'].isExists = (value: string) => value.endsWith('/template_arduino');
    window['fs'].readFileSync = jasmine.createSpy('read').and.callFake((value: string) => JSON.stringify(
      value.includes('/board-old/')
        ? { dependencies: { '@aily-project/board-old': '1', '@aily-project/lib-onebutton': '^1', '@aily-project/lib-display': '^1' } }
        : { dependencies: { [target]: '1', '@aily-project/lib-linkbit_onebutton': '^2', '@aily-project/lib-display': '^3' } },
    ));
    service.isAilyCodeProject = () => true;
    service.getPackageJson = async () => ({ name: 'coder-project', type: 'coder', entry: 'firmware/app.cpp',
      coderBoardTemplateDependencies: { schemaVersion: 1, boardPackageName: '@aily-project/board-old', dependencies: {
        '@aily-project/lib-onebutton': '^1', '@aily-project/lib-display': '^1',
      } }, dependencies: {
        '@aily-project/board-old': '1', '@aily-project/lib-onebutton': '^1', '@aily-project/lib-display': '^2', '@aily-project/lib-user': '4',
      } });
    for (const method of ['applyAilyCodeBoardToPackageManifest', 'filterAilyCodeUserPreservedDeps', 'normalizeAilyCodeBoardDepRange']) {
      service[method] = (ProjectService.prototype as any)[method];
    }
    await ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' });
    const manifest = JSON.parse(window['fs'].writeFileSync.calls.mostRecent().args[1]);
    expect(manifest.dependencies).toEqual({
      [target]: '^1', '@aily-project/lib-linkbit_onebutton': '^2', '@aily-project/lib-display': '^2', '@aily-project/lib-user': '4',
    });
    expect(manifest.entry).toBe('firmware/app.cpp');
    expect(manifest.coderBoardTemplateDependencies).toEqual({ schemaVersion: 1, boardPackageName: target,
      dependencies: { '@aily-project/lib-linkbit_onebutton': '^2' },
    });
    expect(window['fs'].readFileSync.calls.allArgs().some(args => args[0].includes('/board-old/'))).toBeFalse();
    expect(window['fs'].writeFileSync.calls.allArgs().map(args => args[0])).toEqual(['/project/package.json']);
  });

  it('keeps historical same-range user dependencies unowned across consecutive Coder board switches', async () => {
    const service: any = fixture();
    window['path'].isExists = () => true;
    window['fs'].readFileSync = () => JSON.stringify({ dependencies: {
      [target]: '1', '@aily-project/lib-onebutton': '^1', '@aily-project/lib-new-template': '^2',
    } });
    service.isAilyCodeProject = () => true;
    service.getPackageJson = async () => ({ name: 'coder-project', type: 'coder', dependencies: {
      '@aily-project/board-old': '1', '@aily-project/lib-onebutton': '^1',
    } });
    for (const method of ['applyAilyCodeBoardToPackageManifest', 'filterAilyCodeUserPreservedDeps', 'normalizeAilyCodeBoardDepRange']) {
      service[method] = (ProjectService.prototype as any)[method];
    }
    await ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' });
    const manifest = JSON.parse(window['fs'].writeFileSync.calls.mostRecent().args[1]);
    expect(manifest.dependencies['@aily-project/lib-onebutton']).toBe('^1');
    expect(manifest.coderBoardTemplateDependencies.dependencies).toEqual({ '@aily-project/lib-new-template': '^2' });

    const next: any = { dependencies: { '@aily-project/board-third': '1' } };
    service.applyAilyCodeBoardToPackageManifest(next, { name: '@aily-project/board-third', version: '1' }, manifest, target);
    expect(next.dependencies['@aily-project/lib-onebutton']).toBe('^1');
    expect(next.dependencies['@aily-project/lib-new-template']).toBeUndefined();
    expect(next.coderBoardTemplateDependencies.dependencies).toEqual({});
  });

  it('records template-injected dependencies at the real Coder project creation entry', () => {
    const service: any = fixture();
    service.normalizeAilyCodeBoardDepRange = (ProjectService.prototype as any).normalizeAilyCodeBoardDepRange;
    (ProjectService.prototype as any).updateNewProjectPackageJson.call(service, '/project', {
      name: 'My Coder Project', board: { name: target, version: '1' },
    }, { coderTemplate: true });
    const manifest = JSON.parse(window['fs'].writeFileSync.calls.mostRecent().args[1]);
    expect(manifest.type).toBe('coder');
    expect(manifest.coderBoardTemplateDependencies).toEqual({
      schemaVersion: 1, boardPackageName: target, dependencies: { '@aily-project/lib-core': '1' },
    });
  });

  it('does not trust a template receipt belonging to another board', () => {
    const service: any = fixture();
    for (const method of ['applyAilyCodeBoardToPackageManifest', 'filterAilyCodeUserPreservedDeps', 'normalizeAilyCodeBoardDepRange']) {
      service[method] = (ProjectService.prototype as any)[method];
    }
    const next: any = { dependencies: { [target]: '1' } };
    service.applyAilyCodeBoardToPackageManifest(next, { name: target, version: '1' }, {
      type: 'coder', dependencies: { '@aily-project/board-old': '1', '@aily-project/lib-onebutton': '^1' },
      coderBoardTemplateDependencies: { schemaVersion: 1, boardPackageName: '@aily-project/board-unrelated', dependencies: {
        '@aily-project/lib-onebutton': '^1',
      } },
    }, '@aily-project/board-old');
    expect(next.dependencies['@aily-project/lib-onebutton']).toBe('^1');
  });

  it('aborts manifest writes if the project changes during local install', async () => {
    const service = fixture(); let count = 0;
    service.cmdService.runAsyncChecked.and.callFake(async () => { if (++count === 2) service.currentProjectPath = '/other'; });
    await expectAsync(ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' })).toBeRejected();
    expect(window['fs'].writeFileSync).not.toHaveBeenCalled();
    expect(service.finishBoardSwitchWithoutPackageWatcher).not.toHaveBeenCalled();
  });
  it('same-board repair does not wait for an added-board watcher event that can never arrive', async () => {
    const service = fixture(); service.getBoardModule = async () => target;
    service.isPackageJsonBoardWatcherActive = true;
    await ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' });
    expect(service.waitForBoardSwitchReload).not.toHaveBeenCalled();
    expect(service.finishBoardSwitchWithoutPackageWatcher).toHaveBeenCalled();
  });
  it('rejects concurrent board lifecycle work before saving or installing', async () => {
    const service = fixture(); service.isBoardSwitchInProgress = true;
    await expectAsync(ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' })).toBeRejected();
    expect(service.save).not.toHaveBeenCalled();
    expect(service.cmdService.runAsyncChecked).not.toHaveBeenCalled();
  });
  it('does not install a board when the initial save was rejected', async () => {
    const service = fixture(); service.save.and.resolveTo({ success: false, error: 'save rejected' });
    await expectAsync(ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' })).toBeRejectedWithError(/save rejected/);
    expect(service.cmdService.runAsyncChecked).not.toHaveBeenCalled();
    expect(window['fs'].writeFileSync).not.toHaveBeenCalled();
    expect(service.isBoardSwitchInProgress).toBeFalse();
  });

  // Keep actual admission, nested ownership and reload implementation in this
  // regression. Mocking finishBoardSwitch previously hid the self-deadlock.
  function lifecycleFixture() {
    const service: any = fixture();
    const registry = new AiOperationRegistryService();
    registry.setActive('chat', true, { projectPath: '/project' });
    service.application.hasActiveProjectMutation = (path: string) => registry.hasBlocking(path);
    service.projectLifecycle = new ProjectLifecycleGate();
    service.copyPackageJsonToTemp = async () => true;
    service.getProjectMode = () => 'blockly';
    service.boardChangeSubject = { next: jasmine.createSpy('changed') };
    service.message.warning = jasmine.createSpy('warning');
    service.message.success = jasmine.createSpy('success');
    for (const name of ['acquireProjectLifecycle', 'projectOpen', 'normalizeProjectPath', 'isSameProjectPath', 'reloadAfterBoardSwitch', 'finishBoardSwitchWithoutPackageWatcher']) {
      service[name] = (ProjectService.prototype as any)[name];
    }
    service.projectOpenInternal = jasmine.createSpy('load').and.callFake(async () => {
      expect(registry.hasActive('/project')).toBeTrue();
      expect(service.projectLifecycle.hasActive('/project')).toBeTrue();
      expect(() => service.projectLifecycle.acquire(['/project'])).toThrow();
      return true;
    });
    return { service, registry };
  }

  it('switches and reloads through the real lifecycle guard while Chat remains active', async () => {
    const { service, registry } = lifecycleFixture();
    await ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' });
    expect(service.projectOpenInternal).toHaveBeenCalledTimes(1);
    expect(service.boardChangeSubject.next).toHaveBeenCalledTimes(1);
    expect(service.message.success).toHaveBeenCalledTimes(1);
    expect(registry.hasActive('/project')).toBeTrue();
    expect(service.projectLifecycle.hasActive('/project')).toBeFalse();
  });

  it('does not publish board completion when the actual reload returns false', async () => {
    const { service } = lifecycleFixture();
    service.projectOpenInternal.and.resolveTo(false);
    await expectAsync(ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_RELOAD_REJECTED' }));
    expect(service.boardChangeSubject.next).not.toHaveBeenCalled();
    expect(service.message.success).not.toHaveBeenCalled();
    expect(service.projectLifecycle.hasActive('/project')).toBeFalse();
  });

  function coderRouteFixture(routeActive: boolean, navigated = true) {
    const context = { currentPackageData: { name: 'fixture' }, syncCurrentBoardConfig: jasmine.createSpy('sync').and.resolveTo() };
    const service: any = {
      currentProjectPath: '/project', coderProjects: [{ path: '/project' }],
      isSameProjectPath: (a: string, b: string) => a === b,
      ensureProjectModeAllowed: async () => true, getProjectMode: () => 'coder', getCoderOperation: () => undefined,
      electronService: { exists: () => true, setTitle: () => {} },
      configService: { getApplicationName: () => 'Coder' },
      application: { dispatchProjectSave: jasmine.createSpy('save').and.resolveTo({ success: true }) },
      getCoderProjectContext: () => context, publishCoderProjectContext: jasmine.createSpy('publish'),
      projectActivationSubject: { next: jasmine.createSpy('activate') },
      router: { createUrlTree: jasmine.createSpy('target').and.returnValue('coder-target'),
        isActive: jasmine.createSpy('isActive').and.returnValue(routeActive),
        navigate: jasmine.createSpy('navigate').and.resolveTo(navigated) },
    };
    return { service, context, open: () => (ProjectService.prototype as any).projectOpenInternal.call(service, '/project', { reason: 'reload' }) };
  }

  it('reloads a retained Coder frame without treating skipped same-URL navigation as rejection', async () => {
    const { service, context, open } = coderRouteFixture(true);
    expect(await open()).toBeTrue();
    expect(service.application.dispatchProjectSave).toHaveBeenCalledOnceWith('/project', 15000);
    expect(service.projectActivationSubject.next).toHaveBeenCalledOnceWith({ path: '/project', previousPath: '/project', reason: 'reload', sessionResource: null });
    expect(context.syncCurrentBoardConfig).toHaveBeenCalledTimes(1);
    expect(service.router.isActive).toHaveBeenCalledWith('coder-target', { paths: 'exact', queryParams: 'exact', fragment: 'ignored', matrixParams: 'ignored' });
    expect(service.router.navigate).not.toHaveBeenCalled();
  });

  it('still requires successful navigation when the requested Coder route is not active', async () => {
    const { service, open } = coderRouteFixture(false, false);
    expect(await open()).toBeFalse();
    expect(service.router.navigate).toHaveBeenCalledOnceWith(['/main/code-editor-pro'], { queryParams: { path: '/project' }, replaceUrl: true });
  });

  it('does not publish a reload or navigate when saving the retained Coder editor fails', async () => {
    const { service, open } = coderRouteFixture(true);
    service.application.dispatchProjectSave.and.resolveTo({ success: false, error: 'unsaved source' });
    await expectAsync(open()).toBeRejectedWithError('unsaved source');
    expect(service.projectActivationSubject.next).not.toHaveBeenCalled();
    expect(service.router.isActive).not.toHaveBeenCalled();
  });
});
