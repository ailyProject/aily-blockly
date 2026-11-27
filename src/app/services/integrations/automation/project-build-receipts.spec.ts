import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { ProjectBuildReceipts, readNativeBuildReceipt, readProjectBuildRequest } from './project-build-receipts';

describe('project build receipt store', () => {
  const request = (requestId = 'build-1', waitMs = 0) => readProjectBuildRequest({ version: 1, requestId, waitMs });

  it('starts an identical request exactly once and allows different observation budgets', fakeAsync(() => {
    const store = new ProjectBuildReceipts(), run = jasmine.createSpy('run').and.resolveTo({ ok: true });
    const first = jasmine.createSpy('first'), second = jasmine.createSpy('second');
    store.start('/isolated', request(), 'options', run).then(first);
    store.start('/isolated', request('build-1', 10_000), 'options', run).then(second);
    flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(jasmine.objectContaining({
      buildReceipt: jasmine.objectContaining({ state: 'completed' }), result: { ok: true },
    }));
  }));

  it('rejects a reused ID with changed options or a different project without invoking code', () => {
    const store = new ProjectBuildReceipts(), run = jasmine.createSpy('run').and.returnValue(new Promise(() => {}));
    void store.start('/isolated', request(), 'original', run);
    expect(() => store.start('/isolated', request(), 'changed', run)).toThrowError(/different compile options/);
    expect(() => store.start('/another-project', request(), 'original', run)).toThrowError(/another project/);
    expect(() => store.status('/another-project', request())).toThrowError(/another project/);
  });

  it('does not mistake a new renderer or missing receipt for failed or successful compilation', async () => {
    const answer = await new ProjectBuildReceipts().status('/isolated', request());
    expect(answer.buildReceipt.state).toBe('unknown');
    expect(answer.result).toBeUndefined();
  });

  it('uses an exact persisted receipt after renderer replacement without dispatching the original twice', async () => {
    const read = jasmine.createSpy('read').and.returnValue({ state: 'completed', result: { ok: true } });
    const store = new ProjectBuildReceipts(0, 0, read);
    const mutate = jasmine.createSpy('mutate');
    const first = await store.status('/isolated', request());
    expect(first.buildReceipt.state).toBe('completed');
    expect(first.result).toEqual({ ok: true });
    const second = await store.start('/isolated', request(), 'original', mutate);
    expect(second.result).toEqual(first.result);
    expect(read.calls.allArgs()).toEqual([['/isolated', 'build-1'], ['/isolated', 'build-1']]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('reobserves historical source evidence without restoring superseded firmware authority', async () => {
    const original = window['builder'];
    const buildSnapshot = { version: 1, buildRequestId: 'build-1', inputDigest: '1'.repeat(64), sourceSha256: '2'.repeat(64),
      savedAbiHash: `sha256:${'3'.repeat(64)}`, documentSha256: '4'.repeat(64), workspaceRevision: 2, savedMatch: 'different' };
    window['builder'] = { inspectBuildExecution: () => ({ version: 1, buildRequestId: 'build-1', status: 'completed', current: false,
      buildSnapshot, buildInput: { abiHash: buildSnapshot.savedAbiHash } }) };
    try {
      const store = new ProjectBuildReceipts(undefined, undefined, readNativeBuildReceipt);
      const historical = await store.status('/isolated', request());
      expect(historical.result?.['buildSnapshot']).toBe(buildSnapshot);
      expect(historical.result?.['buildInput']).toBeUndefined();
      expect((await store.status('/isolated', request('different-id'))).buildReceipt.state).toBe('unknown');
    } finally { window['builder'] = original; }
  });

  it('reobserves the exact completed log without executing or recreating it', async () => {
    const store = new ProjectBuildReceipts();
    const buildLog = { version: 1, requestId: 'with-log', project: '/isolated', path: '/isolated/.log/compile/requests/owned.log', complete: true };
    const run = jasmine.createSpy('run').and.resolveTo({ ok: true, buildLog });
    const first = await store.start('/isolated', request('with-log', 10_000), 'options', run);
    const status = await store.status('/isolated', request('with-log'));
    const replay = await store.start('/isolated', request('with-log'), 'options', run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(first.result?.['buildLog']).toBe(buildLog);
    expect(status.result?.['buildLog']).toBe(buildLog);
    expect(replay.result?.['buildLog']).toBe(buildLog);
    expect((await new ProjectBuildReceipts().status('/isolated', request('with-log'))).result).toBeUndefined();
  });

  it('observes a durable admission refusal and keeps the same request from replaying', async () => {
    const original = window['builder'];
    const refused = { version: 1, buildRequestId: 'refused', status: 'not-started',
      code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED', message: 'The previous cache owner is unverified.' };
    window['builder'] = { inspectBuildExecution: () => refused };
    try {
      const store = new ProjectBuildReceipts(0, 0, readNativeBuildReceipt);
      const run = jasmine.createSpy('run');
      const status = await store.status('/project', request('refused'));
      expect(status.buildReceipt.state).toBe('completed');
      expect(status.result).toEqual(jasmine.objectContaining({ ok: false, buildOutcome: 'not-started',
        code: refused.code, message: refused.message }));
      expect((await store.start('/project', request('refused'), 'compile', run)).result).toEqual(status.result);
      expect(run).not.toHaveBeenCalled();
    } finally { window['builder'] = original; }
  });

  it('retains running ownership beyond retention while only evicting completed entries', fakeAsync(() => {
    const store = new ProjectBuildReceipts(50, 1);
    let finish!: (result: Record<string, any>) => void;
    const live = new Promise<Record<string, any>>(resolve => { finish = resolve; });
    void store.start('/isolated', request('live'), 'options', () => live);
    void store.start('/isolated', request('old'), 'options', async () => ({ ok: true }));
    flushMicrotasks(); tick(1);
    void store.start('/isolated', request('new'), 'options', async () => ({ ok: true }));
    flushMicrotasks();
    const old = jasmine.createSpy('old'), active = jasmine.createSpy('active'), expired = jasmine.createSpy('expired');
    store.status('/isolated', request('old')).then(old); flushMicrotasks();
    expect(old).toHaveBeenCalledWith(jasmine.objectContaining({ buildReceipt: jasmine.objectContaining({ state: 'unknown' }) }));
    tick(100);
    store.status('/isolated', request('live')).then(active);
    store.status('/isolated', request('new')).then(expired); flushMicrotasks();
    expect(active).toHaveBeenCalledWith(jasmine.objectContaining({ buildReceipt: jasmine.objectContaining({ state: 'running' }) }));
    expect(expired).toHaveBeenCalledWith(jasmine.objectContaining({ buildReceipt: jasmine.objectContaining({ state: 'unknown' }) }));
    finish({ ok: true }); flushMicrotasks();
  }));

  it('captures an unexpected execution rejection as that request terminal failure', async () => {
    const store = new ProjectBuildReceipts();
    const answer = await store.start('/isolated', request('failure', 10_000), 'options', async () => {
      throw Object.assign(new Error('source changed'), { code: 'BUILD_SOURCE_STALE' });
    });
    expect(answer.buildReceipt.state).toBe('completed');
    expect(answer.result).toEqual(jasmine.objectContaining({ ok: false, code: 'BUILD_SOURCE_STALE', message: 'source changed' }));
  });

  const ciCompatibility = { code: 'CI_RESOURCE_UNSUPPORTED', ciResourceReason: 'sdk-toolchain-unsupported' };

  for (const failure of [{ code: 'node_restarted' }, { code: 'CLOUD_TARGET_UNAVAILABLE' }, ciCompatibility]) it(`requires an explicit, separate, same-project request after ${failure.code}`, async () => {
    const store = new ProjectBuildReceipts();
    const guard = jasmine.createSpy('guard');
    const local = jasmine.createSpy('local').and.callFake(async control => {
      expect(control.local.fromRequestId).toBe('cloud');
      await control.local.assertCurrent();
      return { ok: true };
    });
    const first = await store.start('/isolated', request('cloud', 10_000), 'compile', async control => {
      control.recordCloudFailure?.(failure, guard);
      return { ok: false, code: failure.code };
    });
    expect(first.buildReceipt.state).toBe('completed');
    expect(first.result).toEqual({ ok: false, code: failure.code, localFallback: { fromRequestId: 'cloud' } });
    expect((await store.status('/isolated', request('cloud'))).result).toBe(first.result);
    expect(local).not.toHaveBeenCalled();
    expect(() => store.start('/wrong', request('wrong-project'), 'local', local, 'cloud')).toThrowError(/another project/);
    const replay = store.start('/isolated', request('local', 10_000), 'local', local, 'cloud');
    const sameRetry = store.start('/isolated', request('local', 10_000), 'local', local, 'cloud');
    expect(() => store.start('/isolated', request('duplicate'), 'local', local, 'cloud')).toThrowError(/No matching live cloud build failure/);
    expect((await replay).result?.['ok']).toBeTrue();
    expect((await sameRetry).result?.['ok']).toBeTrue();
    expect(local).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledTimes(3);
  });

  it('rejects explicit fallback after the original project source changes', async () => {
    const store = new ProjectBuildReceipts(), local = jasmine.createSpy('local');
    let sourceCurrent = true;
    await store.start('/isolated', request('cloud', 10_000), 'compile', async control => {
      control.recordCloudFailure?.(ciCompatibility, () => {
        if (!sourceCurrent) throw new Error('Original canvas changed.');
      });
      return { ok: false };
    });
    sourceCurrent = false;
    const refused = await store.start('/isolated', request('local', 10_000), 'local', local, 'cloud');
    expect(refused.result).toEqual(jasmine.objectContaining({ ok: false, code: 'BUILD_FALLBACK_UNAVAILABLE', buildOutcome: 'not-started' }));
    expect(local).not.toHaveBeenCalled();
  });

  it('withholds retry authority for ordinary compiler errors, unconfirmed remote cleanup and cancelled requests', async () => {
    const store = new ProjectBuildReceipts(), local = jasmine.createSpy('local');
    const cases = [
      { fault: { code: 'COMPILE_ERROR' }, outcome: 'failed' },
      { fault: { code: 'CI_RESOURCE_UNSUPPORTED' }, outcome: 'failed' },
      { fault: { ...ciCompatibility, cleanupConfirmed: false }, outcome: 'failed' },
      { fault: { ...ciCompatibility, remoteCleanupConfirmed: false }, outcome: 'failed' },
      { fault: { code: 'node_restarted', remoteCleanupConfirmed: false }, outcome: 'failed' },
      { fault: { code: 'node_restarted' }, outcome: 'cancelled' },
    ];
    for (const [index, { fault, outcome }] of cases.entries()) {
      const id = `cloud-${index}`;
      const first = await store.start('/isolated', request(id, 10_000), 'compile', async control => {
        control.recordCloudFailure?.(fault, () => {});
        return { ok: false, buildOutcome: outcome };
      });
      expect(first.result?.['localFallback']).toBeUndefined();
      expect(() => store.start('/isolated', request('local'), 'local', local, id)).toThrowError(/No matching live cloud build failure/);
    }
    expect(local).not.toHaveBeenCalled();
  });

  it('does not authorize an unreported local option when finalizing the cloud build throws', async () => {
    const store = new ProjectBuildReceipts(), local = jasmine.createSpy('local');
    const first = await store.start('/isolated', request('cloud', 10_000), 'compile', async control => {
      control.recordCloudFailure?.({ code: 'CLOUD_BOARD_OFFLINE' }, () => {});
      throw new Error('Cannot finalize the cloud build receipt.');
    });
    expect(first.result?.['localFallback']).toBeUndefined();
    expect(() => store.start('/isolated', request('local'), 'local', local, 'cloud')).toThrowError(/No matching live cloud build failure/);
    expect(local).not.toHaveBeenCalled();
  });

  for (const value of [null, {}, { version: 2, requestId: 'id' }, { version: 1, requestId: '../id' },
    { version: 1, requestId: 'id', waitMs: -1 }, { version: 1, requestId: 'id', waitMs: 10_001 },
    { version: 1, requestId: 'id', waitMs: 0.5 }]) {
    it(`rejects malformed observation ${JSON.stringify(value)}`, () => {
      expect(() => readProjectBuildRequest(value)).toThrowError(/Invalid build receipt/);
    });
  }
});
