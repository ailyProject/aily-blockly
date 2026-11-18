import { ProjectCreateReceipts } from './project-create-receipts';

describe('original project creation settlement', () => {
  const request = () => ({
    version: 1 as const, requestId: crypto.randomUUID(), rendererGeneration: 7, deadlineAt: Date.now() + 100_000,
  });
  const deferred = () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    return { pending, finish };
  };

  it('revokes a stopped request before its first file write and admits an independent new request', async () => {
    const receipts = new ProjectCreateReceipts();
    const original = request(), later = request(), preparation = deferred();
    const writes: string[] = [];
    const first = receipts.run(original, async gate => {
      await preparation.pending;
      gate.assertCurrent();
      writes.push('old');
      return { ok: true };
    });
    expect(receipts.cancel(original).createReceipt.state).toBe('cancelled');
    expect((await first).createReceipt.state).toBe('cancelled');
    await receipts.run(later, async gate => {
      gate.assertCurrent();
      writes.push('new');
      return { ok: true };
    });
    preparation.finish();
    expect((await receipts.run(original, async () => {
      writes.push('replayed'); return { ok: true };
    })).createReceipt.state).toBe('cancelled');
    expect(writes).toEqual(['new']);
  });

  it('preserves the exact project first written before a stop, but revokes its late activation', async () => {
    const receipts = new ProjectCreateReceipts();
    const original = request(), preparation = deferred();
    let activated = false;
    const first = receipts.run(original, async gate => {
      gate.markCreated('/projectA');
      await preparation.pending;
      gate.assertCurrent();
      activated = true;
      return { ok: true };
    });
    expect(receipts.observe({ ...original, rendererGeneration: 8 }).createReceipt.state).toBe('unknown');
    expect(receipts.cancel(original).createReceipt.createdProject).toBe('/projectA');
    preparation.finish();
    expect((await first).createReceipt).toEqual(jasmine.objectContaining({
      state: 'cancelled', createdProject: '/projectA', activationCommitted: false,
    }));
    expect(activated).toBeFalse();
  });

  it('retains completed activation and never replays an observed original request', async () => {
    const receipts = new ProjectCreateReceipts();
    const original = request();
    const opened = await receipts.run(original, async gate => {
      gate.markCreated('/projectA');
      gate.markActivated();
      return { ok: true, operation: 'project_create', project: '/projectA' };
    });
    expect(opened.createReceipt.state).toBe('completed');
    expect(receipts.cancel(original)).toEqual(opened);
    expect(receipts.observe(original)).toEqual(opened);
  });

  it('returns an expired request without starting any work', async () => {
    const receipts = new ProjectCreateReceipts();
    const original = { ...request(), deadlineAt: Date.now() - 1 };
    const start = jasmine.createSpy('start').and.resolveTo({ ok: true });
    expect((await receipts.run(original, start)).createReceipt.state).toBe('cancelled');
    expect(start).not.toHaveBeenCalled();
  });
});
