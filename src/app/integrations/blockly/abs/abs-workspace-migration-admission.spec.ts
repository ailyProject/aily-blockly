import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';

describe('S4 workspace preparation admission', () => {
  it('admits only migration preparation as a publisher and clears its lifecycle mask even on failure', async () => {
    const original = window['fs'];
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    let busy = false;
    bridge.projectService = { currentProjectPath: 'D:/project', getProjectMode: () => 'blockly',
      isProjectTransitionInProgress: () => busy, isLibraryMutationInProgress: () => false };
    bridge.aiOperations = { setActive: jasmine.createSpy('setActive') }; bridge.mutationSequence = 0;
    bridge.executeOperation = jasmine.createSpy('execute').and.resolveTo({ ok: true });
    const read = { operation: 'abs_protocol', path: 'D:/project', params: { version: 1 } };
    const prepare = { ...read, params: { version: 1, action: 'prepare_workspace_migration' } };
    try {
      window['fs'] = {};
      expect((await bridge.execute(prepare)).code).toBe('PROJECT_PROGRAM_HOST_UPDATE_REQUIRED');
      expect(bridge.executeOperation).not.toHaveBeenCalled();
      expect((await bridge.execute(read)).ok).toBeTrue(); expect(bridge.aiOperations.setActive).not.toHaveBeenCalled();
      window['fs'] = { projectProgramPublicationVersion: 1, nativeSaveReceiptVersion: 2,
        projectSyncStorageVersion: 2, openProjectSyncStorage() {} };
      busy = true;
      expect((await bridge.execute(prepare)).reason).toBe('project_lifecycle_busy');
      expect(bridge.executeOperation).toHaveBeenCalledTimes(1);
      busy = false;
      expect((await bridge.execute(prepare)).ok).toBeTrue();
      expect(bridge.aiOperations.setActive.calls.allArgs().map(args => args[1])).toEqual([true, false]);
      bridge.executeOperation.and.rejectWith(new Error('owned preparation failure'));
      await expectAsync(bridge.execute(prepare)).toBeRejectedWithError('owned preparation failure');
      expect(bridge.aiOperations.setActive.calls.allArgs().map(args => args[1])).toEqual([true, false, true, false]);
    } finally { window['fs'] = original; }
  });
});
