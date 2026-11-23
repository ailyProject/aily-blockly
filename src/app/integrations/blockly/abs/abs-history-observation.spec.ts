import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';

describe('ABS disk observation admission', () => {
  const project = 'D:/history-source';
  const requestId = 'pub2-11111111-2222-4333-8444-555555555555';
  const hash = `sha256:${'a'.repeat(64)}`;
  const request = { version: 2, requestId, action: 'history_observe', originalTargetPid: 12345,
    history: { id: 'original-history-step', expected: { generation: 'original-base', scope: { projectKey: project, pageId: 'main' },
      abiHash: hash, absHash: hash, mapHash: hash }, base: { hash, bytes: 21 }, candidate: { hash, bytes: 21 } } };
  const draft = { version: 2, requestId, action: 'read_draft', generation: 'original-base' };

  function fixture(condition: string) {
    const bridge = Object.create(BlocklyLiveOperationBridgeService.prototype);
    const execute = jasmine.createSpy('original disk observer').and.resolveTo({ ok: true, operation: 'abs_recovery' });
    const getLoadStatus = jasmine.createSpy('read canvas readiness').and.returnValue({ ready: false, state: 'loading' });
    const setActive = jasmine.createSpy('set write mask');
    Object.assign(bridge, {
      projectService: { currentProjectPath: project, getProjectMode: () => 'blockly', getBlocklyProjectLoadStatus: getLoadStatus,
        isProjectTransitionInProgress: () => condition === 'loading', isLibraryMutationInProgress: () => condition === 'library-install' },
      aiOperations: { setActive, hasBlocking: () => false }, electronService: {}, absGenerationTools: { execute },
      mutationSequence: 0, boardSwitchInProgress: condition === 'board-switch', absApplyInProgress: condition === 'abs-apply',
    });
    return { bridge, execute, getLoadStatus, setActive };
  }

  for (const condition of ['loading', 'board-switch', 'abs-apply', 'library-install']) {
    it(`reads the original History request and retained draft while ${condition}`, async () => {
      const { bridge, execute, getLoadStatus, setActive } = fixture(condition);
      for (const params of [request, draft]) {
        const result = await bridge.execute({ operation: 'abs_recovery', path: project, params });
        expect(result.ok).toBeTrue();
        expect(execute.calls.mostRecent().args.slice(0, 2)).toEqual(['abs_recovery', params]);
        expect(execute.calls.mostRecent().args[5]).toBe(project);
      }
      expect(execute).toHaveBeenCalledTimes(2);
      expect(getLoadStatus).not.toHaveBeenCalled();
      expect(setActive).not.toHaveBeenCalled();
    });
  }

  it('keeps the original project and protocol checks and the write gate', async () => {
    const { bridge, execute } = fixture('board-switch');
    const observe = (params: Record<string, unknown>, path = project) => bridge.execute({ operation: 'abs_recovery', path, params });
    expect((await observe(request, 'D:/other-project')).ok).toBeFalse();
    expect((await observe({ ...draft, version: 1 })).code).toBe('ABS_PROTOCOL_REQUIRED');
    const original = window['fs'];
    const openProjectSyncStorage = jasmine.createSpy('open a writer');
    window['fs'] = { ...original, projectProgramPublicationVersion: 1, nativeSaveReceiptVersion: 2,
      projectSyncStorageVersion: 2, openProjectSyncStorage } as typeof original;
    try {
      expect((await observe({ ...request, action: 'history_publish' })).reason).toBe('board_switch_in_progress');
    } finally { window['fs'] = original; }
    expect(openProjectSyncStorage).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
