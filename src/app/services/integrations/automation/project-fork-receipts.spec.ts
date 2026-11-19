import { ProjectForkReceipts, readProjectForkRequest, type ProjectForkReceiptStore } from './project-fork-receipts';

describe('request-bound recovery fork observations', () => {
  function fixture() {
    const entries = new Map<string, any>();
    const source = '/private/source', target = '/private/target';
    const sourceHash = 'sha256:' + 'a'.repeat(64), targetHash = 'sha256:' + 'b'.repeat(64);
    const store: ProjectForkReceiptStore = {
      abiHash: path => path === source ? sourceHash : targetHash,
      begin: (project, requestId, signature, sourceAbiHash) => {
        const existing = entries.get(requestId);
        if (existing) { if (existing.signature !== signature) throw Error('options changed'); return { ...existing, created: false }; }
        const entry = { project, requestId, signature, sourceAbiHash, state: 'running' };
        entries.set(requestId, entry); return { ...entry, created: true };
      },
      complete: (_project, requestId, _signature, result, targetAbiHash) => {
        const entry = { ...entries.get(requestId), state: 'completed', result, targetAbiHash };
        entries.set(requestId, entry); return entry;
      },
      status: (_project, requestId) => entries.get(requestId) ?? null,
    };
    const request = { version: 1 as const, requestId: 'fork-request-001' };
    return { store, entries, source, target, request, sourceHash, targetHash };
  }

  it('observes and replays the same completed request without running a second copy', async () => {
    const f = fixture(), receipts = new ProjectForkReceipts(f.store);
    const run = jasmine.createSpy('copy').and.resolveTo({ ok: true, operation: 'project_fork', project: f.target, projectSaved: true });
    const result = await receipts.start(f.source, f.request, 'same-options', run);
    expect(result['forkReceipt']).toEqual(jasmine.objectContaining({ state: 'completed',
      sourceAbiHash: f.sourceHash, targetAbiHash: f.targetHash }));
    const replacement = new ProjectForkReceipts(f.store, result => ({ ...result, activated: false }));
    expect(replacement.status(f.source, f.request)['result']['project']).toBe(f.target);
    expect((await replacement.start(f.source, f.request, 'same-options', run))['activated']).toBeFalse();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports running for a live owner and unknown after replacement without re-executing', async () => {
    const f = fixture(), receipts = new ProjectForkReceipts(f.store);
    let finish!: (result: any) => void;
    const run = jasmine.createSpy('copy').and.returnValue(new Promise(resolve => { finish = resolve; }));
    const pending = receipts.start(f.source, f.request, 'same-options', run);
    expect(receipts.status(f.source, f.request)['forkReceipt']['state']).toBe('running');
    const replacement = new ProjectForkReceipts(f.store);
    expect(replacement.status(f.source, f.request)['forkReceipt']['state']).toBe('unknown');
    expect((await replacement.start(f.source, f.request, 'same-options', run))['code']).toBe('PROJECT_FORK_OUTCOME_UNKNOWN');
    finish({ ok: true, project: f.target, projectSaved: true }); await pending;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not rerun a failed completion or treat an unknown ID as completed', async () => {
    const f = fixture(), receipts = new ProjectForkReceipts(f.store);
    const run = jasmine.createSpy('copy').and.rejectWith(Error('retained source'));
    expect((await receipts.start(f.source, f.request, 'options', run))['ok']).toBeFalse();
    expect(receipts.status(f.source, f.request)['result']['message']).toBe('retained source');
    expect(receipts.status(f.source, { version: 1, requestId: 'missing-id' })['forkReceipt']['state']).toBe('unknown');
    await expectAsync(receipts.start(f.source, f.request, 'different', run)).toBeRejectedWithError('options changed');
  });

  it('keeps request parsing bounded and rejects caller-supplied outcome fields', () => {
    for (const value of [null, {}, { version: 2, requestId: 'request-good' },
      { version: 1, requestId: '../bad' }, { version: 1, requestId: 'request-good', completed: true }])
      expect(() => readProjectForkRequest(value)).toThrowError(/Invalid fork receipt/);
    expect(readProjectForkRequest({ version: 1, requestId: 'request-good' }).requestId).toBe('request-good');
  });
});
