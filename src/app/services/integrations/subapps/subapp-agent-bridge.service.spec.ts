import { SubappAgentBridgeService } from './subapp-agent-bridge.service';

describe('SubappAgentBridgeService dependency materialization', () => {
  function createService(result: unknown) {
    const service = Object.create(SubappAgentBridgeService.prototype) as any;
    service.request = jasmine.createSpy('request').and.resolveTo(result);
    service.releaseSession = jasmine.createSpy('releaseSession').and.resolveTo({ ok: true });
    return service;
  }

  it('uses the project context and releases the temporary runtime owner', async () => {
    const service = createService({ ok: true, ready: true });
    await service.materializeCoderProjectLibraries('/projects/new-coder');
    const args = service.request.calls.mostRecent().args;
    expect(args[0]).toBe('aily-coder-editor');
    expect(args[1]).toBe('coder.library.materialize');
    expect(args[2]).toEqual({});
    expect(args[7]).toEqual({ workspaceRoot: '/projects/new-coder', developmentMode: 'coder' });
    expect(service.releaseSession).toHaveBeenCalledOnceWith(args[6]);
  });

  it('rejects incomplete materialization and releases the runtime on errors', async () => {
    const service = createService({ ok: true, ready: false });
    await expectAsync(service.materializeCoderProjectLibraries('/projects/new-coder')).toBeRejected();
    expect(service.releaseSession).toHaveBeenCalledTimes(1);
    service.request.and.rejectWith(new Error('archive failed'));
    await expectAsync(service.materializeCoderProjectLibraries('/projects/new-coder')).toBeRejectedWithError('archive failed');
    expect(service.releaseSession).toHaveBeenCalledTimes(2);
  });

  it('explains how to recover an old runtime while retaining the original RPC error', async () => {
    const service = createService(null);
    service.request.and.callFake(() => new Promise((_resolve, reject) => {
      const channel = { pending: new Map([['old-runtime', { reject }]]) };
      service.handleMessage(channel, { data: JSON.stringify({
        id: 'old-runtime', ok: false, errorCode: 'SUBAPP_TOOL_METHOD_NOT_FOUND',
        error: 'Unknown Aily Coder Agent method: coder.library.materialize',
      }) });
    }));
    const error = await service.materializeCoderProjectLibraries('/projects/new-coder').catch((value: any) => value);
    expect(error.code).toBe('CODER_RUNTIME_UPDATE_REQUIRED');
    expect(error.message).toContain('保存工程并重新启动');
    expect(error.message).toContain('Unknown Aily Coder Agent method: coder.library.materialize');
    expect(service.releaseSession).toHaveBeenCalledTimes(1);
  });
});
