import { normalizeProjectDataDocument, createProjectDataMarker, type DeferredProjectDataNormalization } from '@domain/project/public-api';
import { AbsBaselineStore, absBaselineKey, type AbsSyncStoragePort, type AbsSyncStorageAccess } from './abs-baseline-store';
import { absJson, createAbsProjection, hashAbsText } from './abs-identity-map';
import { prepareAbsLoadNormalization, verifyAbsLoadNormalization, bindAbsLoadNormalizationReadback,
  matchesAbsLoadNormalizationReadback } from './abs-load-normalization';

class MigrationHost implements AbsSyncStoragePort, AbsSyncStorageAccess {
  files = new Map<string, string>();
  writes: string[] = [];
  async read(key: string) { return this.files.get(key) ?? null; }
  async withLock<T>(operation: (storage: AbsSyncStorageAccess) => Promise<T>) { return operation(this); }
  async replace(key: string, expected: string | null, content: string | null) {
    const before = await this.read(key);
    if ((before === null ? null : await hashAbsText(before)) !== expected) return false;
    this.writes.push(key);
    if (content === null) this.files.delete(key); else this.files.set(key, content);
    return true;
  }
}

describe('trusted ABS load normalization preparation', () => {
  const project = 'D:/isolated-load-normalization', scope = { projectKey: project, pageId: 'main' };
  let host: MigrationHost, store: AbsBaselineStore, receipt: DeferredProjectDataNormalization, original: string;
  let current: boolean;
  const assertCurrent = () => { if (!current) throw new Error('stale load'); };
  beforeEach(async () => {
    current = true; host = new MigrationHost(); store = new AbsBaselineStore(host, scope);
    const page = { id: 'main', title: 'Main', content: { blocks: { blocks: [
      { id: 'keep', type: 'fastled_refresh', deletable: false, collapsed: true },
    ] } } };
    const document = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'], pages: [page],
      sharedModel: { procedureBlocks: [] }, $ailyProjectData: createProjectDataMarker(), extensionState: { retained: true } };
    original = JSON.stringify(document); host.files.set('project.abi', original);
    const projection = await createAbsProjection(page.content, { document, generation: 'old', baselineRef: absBaselineKey('old'),
      scope, savedAbiHash: await hashAbsText(absJson(document)) });
    await store.stage({ projection, mode: 'import', inputAbs: projection.abs, abi: original, expected: await store.captureDisk() });
    await store.commit('old', assertCurrent, async (text, expected, storage) => {
      if (!await storage.replace('project.abi', expected, text)) throw new Error('fixture CAS');
    });
    host.writes = [];
    const normalized = await normalizeProjectDataDocument({ projectPath: project, document, originalContent: original, materialize: true }, {
      put: async () => { throw new Error('No payload write is required'); }, flushPending: async () => {},
      collectReferences: () => [], validateReferences: async () => ({ valid: true, issues: [] }),
      resolve: async <T>(): Promise<T> => { throw new Error('No payload read is required'); },
    }, assertCurrent, { existsSync: () => true, replaceProjectText: async () => { throw new Error('Never independently publish ABI'); } } as any);
    receipt = normalized.deferredNormalization!;
  });

  it('freezes actual clean mirrors and verified original save recipe without publishing anything', async () => {
    const result = await prepareAbsLoadNormalization(project, receipt, host, assertCurrent);
    expect(result.outcome).toBeUndefined(); expect(result.input).toBeDefined();
    expect(result.input!.originalContent).toBe(original);
    expect(JSON.parse(result.input!.persistedText).pages[0].content.blocks.blocks[0]).toEqual({
      id: 'keep', type: 'fastled_show', deletable: false, collapsed: true,
    });
    expect((await verifyAbsLoadNormalization(store, result.input!, scope))!.baseline.map.generation).toBe('old');
    expect(Object.isFrozen(result.input!.expected.disk)).toBeTrue(); expect(host.writes).toEqual([]);
  });

  it('rejects a copied domain receipt and a copied host plan instead of accepting wire authority', async () => {
    const copy = JSON.parse(JSON.stringify(receipt));
    expect((await prepareAbsLoadNormalization(project, copy, host, assertCurrent)).input).toBeUndefined();
    const input = (await prepareAbsLoadNormalization(project, receipt, host, assertCurrent)).input!;
    expect(await verifyAbsLoadNormalization(store, { ...input }, scope)).toBeNull();
    expect(host.writes).toEqual([]);
  });

  it('binds one exact native readback and rejects revision, code, layout or viewport changes before FIFO entry', async () => {
    const input = (await prepareAbsLoadNormalization(project, receipt, host, assertCurrent)).input!;
    const document = JSON.parse(input.persistedText), snapshot = { revision: 12, document };
    expect(matchesAbsLoadNormalizationReadback(input, snapshot)).toBeFalse();
    expect(bindAbsLoadNormalizationReadback(input, snapshot)).toBeTrue();
    expect(matchesAbsLoadNormalizationReadback(input, structuredClone(snapshot))).toBeTrue();
    for (const kind of ['revision', 'code', 'layout', 'viewport']) {
      const changed = structuredClone(snapshot);
      if (kind === 'revision') changed.revision++;
      if (kind === 'code') changed.document.pages[0].content.blocks.blocks[0].type = 'different';
      if (kind === 'layout') changed.document.pages[0].content.blocks.blocks[0].x = 9;
      if (kind === 'viewport') changed.document.pages[0].viewState = { scale: 1.5, scrollX: 0, scrollY: 0 };
      expect(matchesAbsLoadNormalizationReadback(input, changed)).toBeFalse();
      expect(bindAbsLoadNormalizationReadback(input, changed)).toBeFalse();
    }
    expect(matchesAbsLoadNormalizationReadback(input, snapshot)).toBeTrue(); expect(host.writes).toEqual([]);
  });

  for (const key of ['project.abi', 'project.abs', 'project.abs.map.json']) {
    it(`retains original data and defers an independently changed ${key}`, async () => {
      host.files.set(key, host.files.get(key)! + ' ');
      const before = [...host.files];
      const result = await prepareAbsLoadNormalization(project, receipt, host, assertCurrent);
      expect(result.input).toBeUndefined(); expect(result.outcome!.recovery.tool).toBe('project_recover');
      expect([...host.files]).toEqual(before); expect(host.writes).toEqual([]);
    });
  }

  it('never promotes a foreign scope or an unknown historical saved recipe', async () => {
    expect((await prepareAbsLoadNormalization('D:/different', receipt, host, assertCurrent)).input).toBeUndefined();
    spyOn(AbsBaselineStore.prototype, 'readDerivedAbi').and.resolveTo(null);
    expect((await prepareAbsLoadNormalization(project, receipt, host, assertCurrent)).input).toBeUndefined();
    expect(host.writes).toEqual([]);
  });

  it('does not replay a pending journal or reuse the plan after any captured byte changes', async () => {
    const input = (await prepareAbsLoadNormalization(project, receipt, host, assertCurrent)).input!;
    host.files.set('prepared.json', 'unknown journal');
    expect(await verifyAbsLoadNormalization(store, input, scope)).toBeNull();
    host.files.delete('prepared.json'); host.files.set('project.abi', original + '\n');
    expect(await verifyAbsLoadNormalization(store, input, scope)).toBeNull();
    expect(host.writes).toEqual([]);
  });

  it('does not swallow replacement of the project session as an accepted or deferred old load', async () => {
    current = false;
    await expectAsync(prepareAbsLoadNormalization(project, receipt, host, assertCurrent)).toBeRejectedWithError('stale load');
    expect(host.writes).toEqual([]);
  });
});
