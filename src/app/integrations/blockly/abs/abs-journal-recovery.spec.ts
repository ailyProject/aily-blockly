import { AbsBaselineStore, type AbsSyncStorageAccess, type AbsSyncStoragePort } from './abs-baseline-store';
import { absJson, createAbsProjection, hashAbsText } from './abs-identity-map';
import { inspectAbsGeneration } from './abs-generation-inspection';

class JournalMemoryPort implements AbsSyncStoragePort {
  files = new Map<string, string>([['project.abi', '{}'], ['project.abs', 'root(VALUE=0)']]);
  writes: string[] = [];
  fail?: string;
  async read(key: string) { return this.files.get(key) ?? null; }
  withLock<T>(operation: (storage: AbsSyncStorageAccess) => Promise<T>): Promise<T> {
    return operation({ read: key => this.read(key), replace: async (key, expected, content) => {
      if (key === this.fail) throw new Error('isolated journal write failure');
      const previous = await this.read(key);
      if ((previous === null ? null : await hashAbsText(previous)) !== expected) return false;
      this.writes.push(key); if (content === null) this.files.delete(key); else this.files.set(key, content);
      return true;
    } });
  }
}

describe('exact pending journal recovery capability', () => {
  const scope = { projectKey: 'journal-project', pageId: 'main' };
  async function fixture(fail = 'project.abs') {
    const port = new JournalMemoryPort(), store = new AbsBaselineStore(port, scope);
    const stage = async (generation: string, value: number) => {
      const workspace = { blocks: { blocks: [{ id: 'root', type: 'root', fields: { VALUE: value } }] } };
      const projection = await createAbsProjection(workspace, { document: workspace, generation,
        baselineRef: `baselines/${generation}.json`, scope, savedAbiHash: await hashAbsText(absJson(workspace)) });
      await store.stage({ projection, mode: 'import', abi: JSON.stringify(workspace),
        inputAbs: (await store.captureDisk()).abs, expected: await store.captureDisk() });
    };
    const save = async (text: string, expected: string | null, storage: AbsSyncStorageAccess) => {
      if (!await storage.replace('project.abi', expected, text)) throw new Error('ABI CAS conflict');
    };
    await stage('g0', 0); await store.commit('g0', () => {}, save);
    await stage('g1', 1); port.fail = fail;
    const pending = await store.commit('g1', () => {}, save); port.fail = undefined;
    return { port, store, pending, stage };
  }

  it('finishes only the inspected partially committed journal without saving ABI again', async () => {
    const f = await fixture(), beforeAbi = await f.port.read('project.abi');
    const inspection = await inspectAbsGeneration(f.store, scope), journal = inspection.diagnostics.journal!;
    expect(journal.action).toBe('recover'); expect(journal.generation).toBe('g1'); expect(journal.scope).toEqual(scope);
    const at = f.port.writes.length;
    expect((await f.store.recover(() => {}, journal))!.status).toBe('COMMITTED');
    expect(await f.port.read('project.abi')).toBe(beforeAbi); expect(f.port.writes.slice(at)).not.toContain('project.abi');
    expect(await f.store.inspectPending()).toBeNull();
    await expectAsync(f.store.recover(() => {}, journal)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_JOURNAL_RECOVERY_STALE' }));
    expect(await f.store.recover(() => {})).toBeNull();
  });

  it('rejects stale tokens, changed mirrors/pointers and another scope before any recovery writes', async () => {
    for (const changed of ['token', 'generation', 'project.abs', 'project.abi', 'project.abs.map.json', 'prepared.json', 'committed.json', 'scope']) {
      const f = await fixture(), journal = (await f.store.inspectJournalRecovery())!;
      if (changed.startsWith('project.') || changed.endsWith('.json') && !changed.startsWith('scope')) f.port.files.set(changed, '{}');
      const before = [...f.port.files], writes = f.port.writes.length;
      const target = changed === 'scope' ? new AbsBaselineStore(f.port, { projectKey: 'copied-project', pageId: 'main' }) : f.store;
      await expectAsync(target.recover(() => {}, { generation: changed === 'generation' ? 'other' : journal.generation,
        token: changed === 'token' ? 'sha256:' + '0'.repeat(64) : journal.token })).toBeRejected();
      expect([...f.port.files]).toEqual(before); expect(f.port.writes.length).toBe(writes);
    }
  });

  it('cannot use the inspected token for a different newly prepared generation', async () => {
    const f = await fixture(), journal = (await f.store.inspectJournalRecovery())!;
    await f.stage('g2', 2);
    f.port.files.set('prepared.json', absJson({ schemaVersion: 1, generation: 'g2', hash: await hashAbsText(f.port.files.get('baselines/g2.json')!) }));
    const before = [...f.port.files];
    await expectAsync(f.store.recover(() => {}, journal)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_JOURNAL_RECOVERY_STALE' }));
    expect([...f.port.files]).toEqual(before);
  });

  it('offers abandon only when no ABI/mirror was committed and preserves all project files', async () => {
    const f = await fixture('project.abi'), journal = (await f.store.inspectJournalRecovery())!;
    expect(f.pending.status).toBe('NOT_COMMITTED'); expect(journal.action).toBe('abandon');
    const before = await f.store.captureDisk();
    await expectAsync(f.store.recover(() => {}, journal)).toBeRejected();
    await f.store.abandon(journal.generation, journal.token);
    expect(await f.store.captureDisk()).toEqual(before); expect(await f.store.inspectPending()).toBeNull();
  });

  it('keeps the existing strict tokenless recovery for non-frozen legacy callers', async () => {
    const f = await fixture();
    expect((await f.store.recover(() => {}))!.status).toBe('COMMITTED');
  });
});
