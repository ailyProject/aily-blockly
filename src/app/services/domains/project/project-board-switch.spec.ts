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
      appDataResourceLock: { runExclusive: async (_key: string, task: () => Promise<void>) => task() },
      cmdService: { runAsyncChecked: jasmine.createSpy('npm').and.resolveTo() },
      finishBoardSwitchWithoutPackageWatcher: jasmine.createSpy('reload').and.resolveTo(),
      rejectBoardSwitchReload: () => {}, waitForBoardSwitchReload: jasmine.createSpy('waiter').and.resolveTo(),
    };
  }
  it('preserves user library dependencies and uses target template metadata in the same project', async () => {
    const service = fixture();
    await ProjectService.prototype.changeBoard.call(service, { name: target, version: '1' });
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
});
