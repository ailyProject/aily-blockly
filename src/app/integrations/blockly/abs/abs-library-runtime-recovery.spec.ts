import { AbsGenerationToolsService } from './abs-generation-tools.service';

/** Recovery must stay available without consulting a partially rebuilt canvas. */
describe('library runtime snapshot recovery wire', () => {
  const project = '/isolated/runtime-project';
  const token = `sha256:${'a'.repeat(64)}`, snapshotHash = `sha256:${'b'.repeat(64)}`;
  const hostRequestId = 'edcf02fd-310a-4cf9-a700-12fe3c029d71';
  const record = (status: 'available' | 'running' | 'completed' | 'failed' = 'available') => ({
    version: 1, token, requestId: hostRequestId, project, snapshotHash, status,
    ready: status === 'completed', sourcePreserved: true, candidateApplied: false,
  });
  const params = (action: string, extra: Record<string, unknown> = {}) => ({
    version: 2, requestId: hostRequestId, action, token, ...extra,
  });
  function fixture() {
    const sync: any = {
      inspectLibraryRuntimeRecovery: jasmine.createSpy('retained snapshot').and.resolveTo(record()),
      inspectGeneration: jasmine.createSpy('partial canvas').and.throwError('cannot inspect partial canvas'),
      recoverLibraryRuntime: jasmine.createSpy('recover runtime').and.resolveTo({ status: 'completed', value: record('completed') }),
    };
    return { sync, tools: new AbsGenerationToolsService(sync) };
  }

  it('returns the retained full snapshot diagnosis without reading partial generation state', async () => {
    const f = fixture(), result: any = await f.tools.execute('abs_recovery', params('inspect'));
    expect(result.ok).toBeTrue(); expect(result.diagnostics.runtimeRecovery).toEqual(record());
    expect(result.receipt.requestId).toBe(hostRequestId); expect(result.requiresReload).toBeFalse();
    expect(f.sync.inspectGeneration).not.toHaveBeenCalled();
  });
  it('returns to ordinary generation inspection once runtime readback is complete', async () => {
    const f = fixture(); f.sync.inspectLibraryRuntimeRecovery.and.resolveTo(record('completed'));
    f.sync.inspectGeneration.and.resolveTo({ diagnostics: { status: 'ready' }, pending: null });
    const result: any = await f.tools.execute('abs_recovery', params('inspect'));
    expect(result.ok).toBeTrue(); expect(result.diagnostics).toEqual({ status: 'ready' });
    expect(f.sync.inspectGeneration).toHaveBeenCalledTimes(1);
  });
  it('routes the exact original host identity and observes without substituting a new request', async () => {
    const f = fixture();
    const first: any = await f.tools.execute('abs_recovery', params('recover_runtime'));
    const observed: any = await f.tools.execute('abs_recovery', params('recover_runtime', { observe: true }));
    expect(f.sync.recoverLibraryRuntime.calls.allArgs()).toEqual([[token, hostRequestId, false], [token, hostRequestId, true]]);
    expect(first.runtimeRecovery).toEqual(record('completed')); expect(observed.runtimeRecovery).toEqual(first.runtimeRecovery);
    expect(first.receipt).toEqual({ version: 2, action: 'recover_runtime', token, requestId: hostRequestId, candidateApplied: false });
  });
  it('preserves a pending original identity instead of reporting completion or replay', async () => {
    const f = fixture(); f.sync.recoverLibraryRuntime.and.resolveTo({ status: 'running', value: record('running') });
    const result: any = await f.tools.execute('abs_recovery', params('recover_runtime', { observe: true }));
    expect(result.ok).toBeFalse(); expect(result.code).toBe('PROJECT_RUNTIME_RECOVERY_PENDING');
    expect(result.recoveryState).toBe('running'); expect(result.runtimeRecovery).toEqual(record('running'));
    expect(result.receipt.requestId).toBe(hostRequestId); expect(f.sync.recoverLibraryRuntime).toHaveBeenCalledTimes(1);
  });
  it('retains the failed snapshot and precise original error for a complete recovery fork', async () => {
    const f = fixture(), failure = { code: 'RUNTIME_REBUILD_FAILED', message: 'original library failure' };
    f.sync.recoverLibraryRuntime.and.resolveTo({ status: 'failed', value: record('failed'), failure });
    const result: any = await f.tools.execute('abs_recovery', params('recover_runtime'));
    expect(result.ok).toBeFalse(); expect(result.code).toBe(failure.code); expect(result.message).toBe(failure.message);
    expect(result.runtimeRecovery.status).toBe('failed'); expect(f.sync.inspectGeneration).not.toHaveBeenCalled();
  });
  it('does not mix reconstruction with baseline repair or ABS application authority', async () => {
    const f = fixture();
    for (const extra of [{ authority: 'workspace' }, { generation: 'another' }, { token: 'not-a-capability' }, { observe: 'yes' }]) {
      const result: any = await f.tools.execute('abs_recovery', params('recover_runtime', extra));
      expect(result.ok).toBeFalse();
    }
    expect(f.sync.recoverLibraryRuntime).not.toHaveBeenCalled();
  });
});
