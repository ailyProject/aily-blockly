import { AbsBaselineStore, absBaselineKey, AbsSyncStoragePort } from './abs-baseline-store';
import { absJson, createAbsProjection, fingerprintAbsNodes, hashAbsText, indexAbsSyntax, validateAbsProjection } from './abs-identity-map';
import { inspectAbsGeneration } from './abs-generation-inspection';
import { parseAbsSyntax } from './abs-syntax';
import { AbsAbiWorkspace, AbsProjection } from './abs-state';
import { reconcileAbs } from './abs-reconciler';

describe('previous ABS projection inspection and explicit upgrade', () => {
  const scope = { projectKey: 'p', pageId: 'main' };
  let baseline: AbsProjection, files: Map<string, string>, store: AbsBaselineStore;
  const field = { type: 'field_variable', symbol: { kind: 'variable' as const, storage: 'variable-state' as const } };
  beforeEach(async () => {
    const workspace: AbsAbiWorkspace = { variables: [{ name: 'counter', id: 'v', type: '' }], blocks: { blocks: [
      { type: 'set', id: 'set-id', deletable: false, fields: { VAR: { id: 'v' } }, inputs: {
        VALUE: { block: { type: 'get', id: 'get-id', fields: { VAR: { id: 'v' } } } },
      } },
    ] } };
    const abs = '# ABS Schema: 2\n# Project Data Schema: 1 (external-only)\n\nset(VAR="counter", VALUE=get(VAR="counter"))';
    const contracts = { fields: { 'set-id': { VAR: field }, 'get-id': { VAR: field } } };
    const entries = indexAbsSyntax(parseAbsSyntax(abs)), fingerprints = await fingerprintAbsNodes(entries);
    baseline = { document: workspace, workspace, abs, contracts, map: {
      schemaVersion: 1, absSchemaVersion: 2, projectionVersion: 'abs-v2.preview.3', generation: 'previous',
      scope, baselineRef: absBaselineKey('previous'), baseAbiHash: await hashAbsText(absJson(workspace)),
      pageAbiHash: await hashAbsText(absJson(workspace)), savedAbiHash: await hashAbsText(absJson(workspace)),
      baseAbsHash: await hashAbsText(abs), contractsHash: await hashAbsText(absJson(contracts)),
      nodes: entries.map(({ node, path }, i) => ({ nodeKey: `n${i}`, blockId: i ? 'get-id' : 'set-id', blockType: node.type,
        astPath: path, start: node.start, end: node.end, fingerprint: fingerprints.get(path)! })),
      symbols: entries.map(({ path }, i) => ({ nodeKey: `n${i}`, astPath: `${path}/fields/VAR`, kind: 'variable', modelId: 'v' })),
    } };
    const record = absJson({ schemaVersion: 1, mode: 'export', projection: baseline, inputAbs: null, abi: null,
      previousCommitted: null, expected: { abi: await hashAbsText(absJson(workspace)), abs: null, map: null } });
    files = new Map([[absBaselineKey('previous'), record], ['project.abs', abs], ['project.abi', absJson(workspace)],
      ['project.abs.map.json', absJson(baseline.map)],
      ['committed.json', absJson({ schemaVersion: 1, generation: 'previous', hash: await hashAbsText(record) })]]);
    const access = { read: async (key: string) => files.get(key) ?? null, replace: async (key: string, expected: string | null, content: string | null) => {
      const before = files.get(key);
      if ((before === undefined ? null : await hashAbsText(before)) !== expected) return false;
      if (content === null) files.delete(key); else files.set(key, content);
      return true;
    } };
    const port: AbsSyncStoragePort = { ...access, withLock: action => action(access) };
    store = new AbsBaselineStore(port, scope);
  });

  it('verifies original quoted-name bytes/offsets for inspection but rejects ordinary load, reconcile and commit', async () => {
    await validateAbsProjection(baseline, true);
    const before = [...files];
    await expectAsync(validateAbsProjection(baseline)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROJECTION_UPGRADE_REQUIRED' }));
    await expectAsync(reconcileAbs(baseline, baseline.abs)).toBeRejected();
    await expectAsync(store.loadCommitted()).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROJECTION_UPGRADE_REQUIRED' }));
    await expectAsync(store.commit('previous', () => {}, async () => {})).toBeRejected();
    const inspection = await inspectAbsGeneration(store, scope);
    expect(inspection.diagnostics.issues).toEqual(['ABS_PROJECTION_UPGRADE_REQUIRED']);
    expect(inspection.diagnostics.rebind?.token).toMatch(/^sha256:/);
    expect([...files]).toEqual(before);
  });

  it('uses the existing export transaction to replace mirrors, preserving ABI and the original baseline', async () => {
    const inspection = await inspectAbsGeneration(store, scope);
    const originalAbi = files.get('project.abi'), originalRecord = files.get(absBaselineKey('previous'));
    const projection = await createAbsProjection(baseline.workspace, { ...baseline.map, generation: 'current',
      baselineRef: absBaselineKey('current'), document: baseline.document, contracts: baseline.contracts });
    expect(projection.abs).toContain('VAR=$counter');
    await store.stage({ mode: 'export', projection, inputAbs: inspection.disk.abs, inputMap: inspection.disk.map,
      abi: null, expected: inspection.disk }, inspection.committed!.pointerHash);
    const save = jasmine.createSpy('must not save ABI');
    expect((await store.commit('current', () => {}, save)).status).toBe('COMMITTED');
    expect(save).not.toHaveBeenCalled();
    expect(files.get('project.abi')).toBe(originalAbi);
    expect(files.get(absBaselineKey('previous'))).toBe(originalRecord);
    expect((await store.loadCommitted())!.map.projectionVersion).toBe('abs-v2.preview.5');
  });

  it('does not offer upgrade when ABS has unapplied edits or a pending journal exists', async () => {
    files.set('project.abs', baseline.abs + '\n# user edit');
    expect((await inspectAbsGeneration(store, scope)).diagnostics.rebind).toBeUndefined();
    files.set('project.abs', baseline.abs);
    files.set('prepared.json', files.get('committed.json')!);
    expect((await inspectAbsGeneration(store, scope)).diagnostics.rebind).toBeUndefined();
  });

  it('continues checksum/map validation for previous versions, not merely trusting the version label', async () => {
    baseline.map.nodes[1].start++;
    await expectAsync(validateAbsProjection(baseline, true)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MAP_INVALID' }));
    baseline.map.projectionVersion = 'unknown-version';
    await expectAsync(validateAbsProjection(baseline, true)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROJECTION_UNSUPPORTED' }));
  });

  it('recognizes the previous positional projection for recovery without applying stale offsets', async () => {
    const positional = await createAbsProjection(baseline.workspace, { ...baseline.map, document: baseline.document, contracts: baseline.contracts });
    // Non-branch formatting is unchanged between .4 and .5.
    positional.map.projectionVersion = 'abs-v2.preview.4';
    await validateAbsProjection(positional, true);
    await expectAsync(validateAbsProjection(positional)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROJECTION_UPGRADE_REQUIRED' }));
    positional.map.nodes[0].start++;
    await expectAsync(validateAbsProjection(positional, true)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MAP_INVALID' }));
  });

  it('recovers a previous journal byte-for-byte before offering a new projection upgrade', async () => {
    files.set('prepared.json', files.get('committed.json')!);
    const abs = files.get('project.abs'), abi = files.get('project.abi');
    expect((await store.recover(() => {}))!.status).toBe('COMMITTED');
    expect(files.get('project.abs')).toBe(abs); expect(files.get('project.abi')).toBe(abi);
    expect(files.has('prepared.json')).toBeFalse();
    expect((await inspectAbsGeneration(store, scope)).diagnostics.issues).toEqual(['ABS_PROJECTION_UPGRADE_REQUIRED']);
  });
});
