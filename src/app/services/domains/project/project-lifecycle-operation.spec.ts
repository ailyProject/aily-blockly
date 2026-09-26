import { BehaviorSubject } from 'rxjs';
import { ProjectService } from './project.service';
import { ProjectLifecycleGate } from './project-lifecycle-gate';
import { AiOperationRegistryService, BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';

describe('project lifecycle admission across sessions', () => {
  function fixture() {
    const service: any = Object.create(ProjectService.prototype);
    const registry = new AiOperationRegistryService();
    service.projectLifecycle = new ProjectLifecycleGate();
    service.currentProjectPathSubject = new BehaviorSubject('/a');
    service.coderProjectsSubject = new BehaviorSubject([]);
    service.coderOperationsSubject = new BehaviorSubject(new Map());
    service.messageService = { warning: jasmine.createSpy('warning') };
    service.getProjectMode = () => 'blockly';
    service.projectOpenInternal = jasmine.createSpy('open').and.resolveTo(true);
    service.closeInternal = jasmine.createSpy('close').and.resolveTo(true);
    service.stopProjectCommands = jasmine.createSpy('stopCommands').and.resolveTo();
    Object.defineProperty(service, 'application', { value: { hasActiveProjectMutation: (path: string) => registry.hasBlocking(path) } });
    return { service, registry };
  }

  it('allows manual open, reload and close while a session remains active', async () => {
    const { service, registry } = fixture();
    registry.setActive('chat', true, { projectPath: '/a', sessionId: 'session-a' });
    expect(await service.projectOpen('/b')).toBeTrue();
    expect(await service.projectOpen('/a', { reason: 'reload' })).toBeTrue();
    expect(await service.close()).toBeTrue();
    expect(registry.hasActive('/a')).toBeTrue();
  });

  it('does not let chat tool names or the former close bypass evade a real write', async () => {
    const { service, registry } = fixture();
    registry.setActive('write', true, { projectPath: '/a', blocksProjectLifecycle: true });
    for (const reason of ['open', 'reload', 'chat-tool-open', 'chat-tool-reload', 'chat-tool-create']) {
      expect(await service.projectOpen('/b', { reason })).toBeFalse();
    }
    expect(await service.close({ allowDuringChatTool: true })).toBeFalse();
    expect(service.projectOpenInternal).not.toHaveBeenCalled();
    expect(service.closeInternal).not.toHaveBeenCalled();
  });

  it('keeps board ownership during its internal reload while blocking unrelated disposal', async () => {
    const { service, registry } = fixture();
    registry.setActive('chat', true, { projectPath: '/a' });
    const board = service.acquireProjectLifecycle(['/a']);
    service.boardSwitchLifecycle = { projectPath: '/a', token: board.token };
    expect(await service.projectOpen('/b', { reason: 'chat-tool-open' })).toBeFalse();
    expect(await service.close()).toBeFalse();
    await expectAsync(service.reloadAfterBoardSwitch('/a')).toBeResolved();
    expect(service.isProjectTransitionInProgress('/a')).toBeTrue();
    board.release(); expect(service.isProjectTransitionInProgress('/a')).toBeFalse();
  });

  it('propagates reload rejection instead of reporting a completed board switch', async () => {
    const { service } = fixture();
    service.projectOpenInternal.and.resolveTo(false);
    await expectAsync(service.reloadAfterBoardSwitch('/a')).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_RELOAD_REJECTED' }));
    expect(service.isProjectTransitionInProgress('/a')).toBeFalse();
  });

  it('allows activating retained Coder projects during another project write, but not reload/disposal', async () => {
    const { service, registry } = fixture();
    service.getProjectMode = () => 'coder';
    service.coderProjectsSubject.next([{ path: '/a' }, { path: '/b' }]);
    registry.setActive('write-b', true, { projectPath: '/b', blocksProjectLifecycle: true });
    expect(await service.projectOpen('/b', { reason: 'chat-tool-open' })).toBeTrue();
    expect(await service.projectOpen('/b', { reason: 'chat-tool-reload' })).toBeFalse();
    expect(await service.close()).toBeFalse();
    registry.setActive('write-a', true, { projectPath: '/a', blocksProjectLifecycle: true });
    expect(await service.projectOpen('/a')).toBeFalse(); // implicit same-path reload
  });

  it('protects save-through-close and does not dispose if saving fails', async () => {
    const { service } = fixture();
    service.getBlocklyProjectLoadStatus = () => ({ ready: true });
    service.save = jasmine.createSpy('save').and.callFake(async () => {
      expect(service.isProjectTransitionInProgress('/a')).toBeTrue();
      expect(await service.projectOpen('/b')).toBeFalse();
      return { success: false, error: 'disk full' };
    });
    await expectAsync(service.close({ save: true })).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_SAVE_FAILED' }));
    expect(service.closeInternal).not.toHaveBeenCalled();
    expect(service.isProjectTransitionInProgress('/a')).toBeFalse();
  });

  it('does not close the active project for a stale cross-project tool request', async () => {
    const { service } = fixture();
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.projectService = service;
    const result = await bridge.execute({ operation: 'project_close', path: '/other' });
    expect(result.reason).toBe('project_mismatch');
    expect(service.closeInternal).not.toHaveBeenCalled();
    service.currentProjectPathSubject.next('');
    expect((await bridge.execute({ operation: 'project_close', path: '/other' })).ok).toBeTrue();
    expect(service.closeInternal).not.toHaveBeenCalled();
  });

  it('releases lifecycle ownership if the loader throws', async () => {
    const { service } = fixture();
    service.projectOpenInternal.and.rejectWith(new Error('load failed'));
    await expectAsync(service.projectOpen('/b')).toBeRejectedWithError('load failed');
    expect(service.isProjectTransitionInProgress('/a')).toBeFalse();
    expect(service.isProjectTransitionInProgress('/b')).toBeFalse();
  });

  it('protects the entire host mutation including its asynchronous tail and always releases it', async () => {
    const { service, registry } = fixture();
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.projectService = service; bridge.aiOperations = registry; bridge.mutationSequence = 0;
    bridge.executeOperation = async () => {
      expect(registry.hasBlocking('/a')).toBeTrue();
      expect(await service.close()).toBeFalse();
      throw new Error('write failed');
    };
    await expectAsync(bridge.execute({ operation: 'project_save', path: '/a' })).toBeRejectedWithError('write failed');
    expect(registry.hasBlocking('/a')).toBeFalse();
  });

  it('rejects new writes while an authorized board reload holds the project', async () => {
    const { service, registry } = fixture();
    const board = service.acquireProjectLifecycle(['/a']);
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.projectService = service; bridge.aiOperations = registry;
    bridge.executeOperation = jasmine.createSpy('operation');
    const result = await bridge.execute({ operation: 'project_save', path: '/a' });
    expect(result.reason).toBe('project_lifecycle_busy');
    expect(bridge.executeOperation).not.toHaveBeenCalled();
    board.release();
  });

  for (const sameBoard of [false, true]) {
    it(`protects board runtime synchronization and readback after native ownership ends (sameBoard=${sameBoard})`, async () => {
      const { service, registry } = fixture();
      const target = '@aily-project/board-new';
      let board = sameBoard ? target : '@aily-project/board-old';
      service.currentBoardConfig = {};
      service.isAilyCodeProject = () => false;
      service.getRuntimeBoardModule = () => board;
      service.getPackageJson = async () => ({ dependencies: { [board]: '1' } });
      service.getBlocklyProjectLoadStatus = () => ({ ready: true });
      service.changeBoard = async () => {
        expect(registry.hasBlocking('/a')).toBeFalse();
        const lease = service.acquireProjectLifecycle(['/a']);
        service.boardSwitchLifecycle = { projectPath: '/a', token: lease.token };
        try { await service.reloadAfterBoardSwitch('/a'); board = target; }
        finally { service.boardSwitchLifecycle = null; lease.release(); }
      };
      const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
      bridge.projectService = service; bridge.aiOperations = registry;
      bridge.configService = { init: async () => {}, boardDict: { [target]: { version: '1' } } };
      bridge.runBlockWritingOperation = (task: () => Promise<unknown>) => task();
      bridge.executeLibraryRuntimeSync = async () => {
        expect(registry.hasBlocking('/a')).toBeTrue();
        expect(await service.close()).toBeFalse();
        return { ready: true };
      };
      registry.setActive('chat', true, { projectPath: '/a' });
      expect((await bridge.executeBoardSwitch({ boardName: target })).ok).toBeTrue();
      expect(registry.hasActive('/a')).toBeTrue();
      expect(registry.hasBlocking('/a')).toBeFalse();
      expect(service.isProjectTransitionInProgress('/a')).toBeFalse();
    });
  }
});
