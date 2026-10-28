import { BehaviorSubject, Subject } from 'rxjs';
import { ProjectService } from './project.service';
import { ProjectLifecycleGate } from './project-lifecycle-gate';
import { projectDataRuntime } from './project-data/project-data-runtime';
import { AiOperationRegistryService, BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';

describe('exact host journal reopen provenance', () => {
  const source = '/isolated/journal-project';
  let service: any, application: any, status: jasmine.Spy;
  let previousLibraries: any;

  beforeEach(() => {
    previousLibraries = window['libraryDependencies'];
    status = jasmine.createSpy('library status').and.resolveTo({ dirty: false, busy: false });
    window['libraryDependencies'] = { status } as any;
    service = Object.create(ProjectService.prototype);
    service.currentProjectPathSubject = new BehaviorSubject(source);
    service.stateSubject = new BehaviorSubject('loaded');
    service.loadedBlocklyProjectPath = source;
    service.projectLifecycle = new ProjectLifecycleGate();
    service.projectOpenTask = null;
    service.coderOperations = new Map();
    service.coderOperationsSubject = new BehaviorSubject(new Map());
    service.coderProjectsSubject = new BehaviorSubject([]);
    service.projectActivationSubject = new Subject();
    service.getProjectMode = jasmine.createSpy('mode').and.returnValue('blockly');
    service.configService = { getCompileSettingsKey: () => 'local' };
    service.electronService = { exists: () => true, isElectron: false };
    service.ensureProjectModeAllowed = async () => true;
    service.publishCoderWorkspaceContext = () => {};
    service.publishCoderOperations = () => {};
    service.save = jasmine.createSpy('save').and.throwError('must not save');
    service.discardLibraryChanges = jasmine.createSpy('discard').and.throwError('must not discard');
    service.stopProjectCommands = jasmine.createSpy('stop').and.throwError('must not stop');
    service.messageService = { warning: jasmine.createSpy('warning') };
    application = { hasActiveProjectMutation: jasmine.createSpy('mutation').and.returnValue(false),
      hasActiveBlocklyBuildOrUpload: jasmine.createSpy('build').and.returnValue(false) };
    Object.defineProperty(service, 'application', { value: application });
    spyOn(projectDataRuntime, 'isConfigured').and.returnValue(true);
    service.routerService = { url: '/main/blockly-editor', navigate: jasmine.createSpy('navigate').and.callFake(async (route: string[]) => {
      if (route[0] === '/main/blockly-editor') {
        const session = service.dependencyLifecycle.get(source);
        service.dependencyLifecycle.finishPreparation(session);
        service.markBlocklyProjectLoaded(source);
      }
      return true;
    }) };
  });

  afterEach(() => { window['libraryDependencies'] = previousLibraries; });

  it('re-enters the normal lifecycle and load transaction, without save/discard/stop or checking the retired context', async () => {
    let oldCanvas = true;
    const guard = jasmine.createSpy('old context').and.callFake(() => { if (!oldCanvas) throw new Error('old workspace retired'); });
    service.router.navigate.and.callFake(async (route: string[]) => {
      expect(service.isProjectTransitionInProgress(source)).toBeTrue();
      if (route[0] === '/main/guide') oldCanvas = false;
      if (route[0] === '/main/blockly-editor') {
        service.dependencyLifecycle.finishPreparation(service.dependencyLifecycle.get(source));
        service.markBlocklyProjectLoaded(source);
      }
      return true;
    });
    expect(await service.reopenRecoveredBlocklyProject(source, guard)).toEqual({ project: source, activated: true });
    expect(guard.calls.count()).toBeGreaterThan(1);
    expect(service.router.navigate.calls.allArgs().map((args: any[]) => args[0][0])).toEqual(['/main/guide', '/main/blockly-editor']);
    expect(service.save).not.toHaveBeenCalled(); expect(service.discardLibraryChanges).not.toHaveBeenCalled();
    expect(service.stopProjectCommands).not.toHaveBeenCalled(); expect(service.isProjectTransitionInProgress(source)).toBeFalse();
  });

  for (const dirty of [{ dirty: true, busy: false }, { dirty: false, busy: true }, {}, null]) {
    it(`retains unverified/pending library state ${JSON.stringify(dirty)} before navigation`, async () => {
      status.and.resolveTo(dirty);
      await expectAsync(service.reopenRecoveredBlocklyProject(source, () => {})).toBeRejected();
      expect(service.router.navigate).not.toHaveBeenCalled(); expect(service.save).not.toHaveBeenCalled();
      expect(service.discardLibraryChanges).not.toHaveBeenCalled(); expect(service.stopProjectCommands).not.toHaveBeenCalled();
      expect(service.isProjectTransitionInProgress(source)).toBeFalse();
    });
  }

  for (const busy of ['build', 'mutation', 'dependency', 'opening', 'transition']) {
    it(`does not interrupt ${busy} ownership`, async () => {
      if (busy === 'build') application.hasActiveBlocklyBuildOrUpload.and.returnValue(true);
      if (busy === 'mutation') application.hasActiveProjectMutation.and.returnValue(true);
      if (busy === 'dependency') service.dependencyLifecycle.beginPreparation(source);
      if (busy === 'opening') service.projectOpenTask = { path: source };
      const lease = busy === 'transition' ? service.projectLifecycle.acquire([source]) : undefined;
      await expectAsync(service.reopenRecoveredBlocklyProject(source, () => {})).toBeRejected();
      expect(status).not.toHaveBeenCalled(); expect(service.router.navigate).not.toHaveBeenCalled();
      expect(service.stopProjectCommands).not.toHaveBeenCalled(); lease?.release();
    });
  }

  it('rejects another path and Coder without using ordinary reload provenance', async () => {
    await expectAsync(service.reopenRecoveredBlocklyProject('/another', () => {})).toBeRejected();
    service.getProjectMode.and.returnValue('coder');
    await expectAsync(service.reopenRecoveredBlocklyProject(source, () => {})).toBeRejected();
    expect(status).not.toHaveBeenCalled(); expect(service.router.navigate).not.toHaveBeenCalled();
  });

  it('checks original canvas and library facts again after asynchronous reads before teardown', async () => {
    status.and.returnValues(Promise.resolve({ dirty: false, busy: false }), Promise.resolve({ dirty: true, busy: false }));
    await expectAsync(service.reopenRecoveredBlocklyProject(source, () => {})).toBeRejectedWithError(/Library state changed/);
    expect(service.router.navigate).not.toHaveBeenCalled(); expect(service.isProjectTransitionInProgress(source)).toBeFalse();
    let current = true;
    status.and.callFake(async () => { current = false; return { dirty: false, busy: false }; });
    await expectAsync(service.reopenRecoveredBlocklyProject(source, () => { if (!current) throw new Error('stale canvas'); }))
      .toBeRejectedWithError('stale canvas');
    expect(service.router.navigate).not.toHaveBeenCalled(); expect(service.stopProjectCommands).not.toHaveBeenCalled();
  });

  it('does not claim activation when normal project loading fails', async () => {
    service.router.navigate.and.callFake(async (route: string[]) => {
      if (route[0] === '/main/blockly-editor') service.markBlocklyProjectLoadFailed(source, 'isolated load failed');
      return true;
    });
    await expectAsync(service.reopenRecoveredBlocklyProject(source, () => {})).toBeRejectedWithError('isolated load failed');
    expect(service.isProjectTransitionInProgress(source)).toBeFalse(); expect(service.stopProjectCommands).not.toHaveBeenCalled();
  });

  it('keeps reopen and read-only inspect free of self-owned writer masks without exempting recovery writes or another writer', async () => {
    const registry = new AiOperationRegistryService();
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.projectService = service; bridge.aiOperations = registry; bridge.mutationSequence = 0;
    bridge.executeOperation = jasmine.createSpy('dispatch').and.callFake(async () => ({ blocked: registry.hasBlocking(source) }));
    const params = { version: 2, requestId: 'journal-reopen-test', action: 'reopen', generation: 'g1', token: 'host-owned' };
    expect((await bridge.executeAdmittedOperation({ operation: 'abs_recovery', path: source, params })).blocked).toBeFalse();
    expect((await bridge.executeAdmittedOperation({ operation: 'abs_recovery', path: source,
      params: { version: 2, requestId: 'journal-inspect-test', action: 'inspect' } })).blocked).toBeFalse();
    expect((await bridge.executeAdmittedOperation({ operation: 'abs_recovery', path: source,
      params: { ...params, action: 'repair' } })).blocked).toBeTrue();
    registry.setActive('foreign writer', true, { projectPath: source, blocksProjectLifecycle: true });
    expect((await bridge.executeAdmittedOperation({ operation: 'abs_recovery', path: source, params })).blocked).toBeTrue();
    expect((await bridge.executeAdmittedOperation({ operation: 'abs_recovery', path: source,
      params: { version: 2, requestId: 'journal-inspect-test', action: 'inspect' } })).blocked).toBeTrue();
    registry.setActive('foreign writer', false);
  });
});
