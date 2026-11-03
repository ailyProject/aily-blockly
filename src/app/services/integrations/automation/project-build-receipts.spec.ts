import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { ProjectBuildReceipts, readProjectBuildRequest } from './project-build-receipts';

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

  for (const value of [null, {}, { version: 2, requestId: 'id' }, { version: 1, requestId: '../id' },
    { version: 1, requestId: 'id', waitMs: -1 }, { version: 1, requestId: 'id', waitMs: 10_001 },
    { version: 1, requestId: 'id', waitMs: 0.5 }]) {
    it(`rejects malformed observation ${JSON.stringify(value)}`, () => {
      expect(() => readProjectBuildRequest(value)).toThrowError(/Invalid build receipt/);
    });
  }
});
