import { AiOperationRegistryService, BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';
import { AbsGenerationToolsService } from './abs-generation-tools.service';

describe('runtime recovery remains reachable through failed editor admission', () => {
  const path = '/isolated/runtime', requestId = 'ec896615-6e39-4247-b887-f7a2c6127f0e', token = `sha256:${'a'.repeat(64)}`;
  function fixture() {
    const record = { version: 1, token, requestId, project: path, snapshotHash: `sha256:${'b'.repeat(64)}`,
      status: 'completed', ready: true, sourcePreserved: true, candidateApplied: false };
    const sync: any = { recoverLibraryRuntime: jasmine.createSpy().and.callFake(async (_token, _id, observe) => ({
      status: 'completed', value: record, freshCompletion: !observe })),
      inspectLibraryRuntimeRecovery: jasmine.createSpy().and.resolveTo({ ...record, status: 'available', ready: false }),
      inspectGeneration: jasmine.createSpy().and.throwError('partial canvas is not inspectable') };
    const acknowledge = jasmine.createSpy('single-use runtime acknowledgement').and.returnValue(true);
    const bridge: any = Object.assign(Object.create(BlocklyLiveOperationBridgeService.prototype), {
      mutationSequence: 0, absGenerationTools: new AbsGenerationToolsService(sync), aiOperations: new AiOperationRegistryService(),
      getProjectRuntimeStatus: () => ({ ready: false, error: 'library failed' }),
      projectService: { currentProjectPath: path, getProjectMode: () => 'blockly', isProjectOpening: false,
        isProjectTransitionInProgress: () => false, hasBlocklyRuntimeRecovery: () => true,
        captureBlocklyRuntimeRecoveryAcknowledgement: jasmine.createSpy('capture input').and.resolveTo(acknowledge),
        markBlocklyLibraryRuntimeReady: jasmine.createSpy('markReady') } });
    const call = (action: string, extra: any = {}) => bridge.executeAdmittedOperation({ operation: 'abs_recovery', path,
      params: { version: 2, requestId, token, action, ...extra } });
    return { bridge, sync, call, acknowledge };
  }
  it('inspects the full managed snapshot instead of serializing a failed partial view', async () => {
    const f = fixture(), result = await f.call('inspect');
    expect(result.ok).toBeTrue(); expect(result.diagnostics.runtimeRecovery.status).toBe('available');
    expect(f.sync.inspectGeneration).not.toHaveBeenCalled();
  });
  it('does not reject recovery because its own generic mutation mask blocks lifecycle', async () => {
    const f = fixture(), result = await f.call('recover_runtime');
    expect(result.ok).toBeTrue(); expect(f.sync.recoverLibraryRuntime).toHaveBeenCalledOnceWith(token, requestId, false);
    expect(f.acknowledge).toHaveBeenCalledTimes(1);
    expect(f.bridge.projectService.markBlocklyLibraryRuntimeReady).not.toHaveBeenCalled();
    expect(f.bridge.aiOperations.hasBlocking(path)).toBeFalse();
  });
  it('retains genuine other-writer protection and never starts a restore', async () => {
    const f = fixture(); f.bridge.aiOperations.setActive('real-writer', true, { projectPath: path, blocksProjectLifecycle: true });
    const result = await f.call('recover_runtime'); expect(result.ok).toBeFalse(); expect(result.code).toBe('PROJECT_RECOVERY_SOURCE_BUSY');
    expect(f.sync.recoverLibraryRuntime).not.toHaveBeenCalled(); expect(f.bridge.aiOperations.hasBlocking(path)).toBeTrue();
  });
  it('can observe the original receipt while another owner is active, without clearing it', async () => {
    const f = fixture(); f.bridge.aiOperations.setActive('new-writer', true, { projectPath: path, blocksProjectLifecycle: true });
    const result = await f.call('recover_runtime', { observe: true }); expect(result.ok).toBeTrue();
    expect(f.sync.recoverLibraryRuntime).toHaveBeenCalledOnceWith(token, requestId, true);
    expect(f.bridge.aiOperations.hasBlocking(path)).toBeTrue();
    expect(f.acknowledge).not.toHaveBeenCalled();
    expect(f.bridge.projectService.captureBlocklyRuntimeRecoveryAcknowledgement).not.toHaveBeenCalled();
  });
  it('a repeated completed start cannot acknowledge later generator files', async () => {
    const f = fixture(); await f.call('recover_runtime'); f.acknowledge.calls.reset();
    f.sync.recoverLibraryRuntime.and.resolveTo({ status: 'completed', value: { status: 'completed', ready: true } });
    const repeated = await f.call('recover_runtime'); expect(repeated.ok).toBeTrue();
    expect(f.acknowledge).not.toHaveBeenCalled(); expect(f.bridge.projectService.markBlocklyLibraryRuntimeReady).not.toHaveBeenCalled();
  });
});
