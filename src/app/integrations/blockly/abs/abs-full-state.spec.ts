import { absMapJson } from './abs-map-json';
import { createAbsProjection, absJson, validateAbsProjection, indexAbsAbi, reconstructAbsProjection } from './abs-identity-map';
import { assertAbsStateUnchanged, decodeAbsState, splitAbsState, encodeAbsState } from './abs-full-state';
import { AbsAbiWorkspace } from './abs-state';

const workspace = (): AbsAbiWorkspace => ({ blocks: { languageVersion: 0, blocks: [{
  type: 'root', id: 'setup', deletable: false, movable: false,
  icons: { comment: { text: '完整注释\n第二行', pinned: true, width: 180, height: 90 } },
  disabledReasons: ['MANUALLY_DISABLED'], custom: { nested: [null, false, 2] },
  fields: { TEXT: 'visible-value-once' }, inputs: { VALUE: {
    shadow: { id: 'hidden', type: 'number', fields: { NUM: 17 }, editable: false },
    block: { id: 'real', type: 'number', fields: { NUM: 42 }, extraState: { variant: 2 } }, connectionData: 'kept',
  }, EMPTY: {} }, next: { block: { type: 'tail', id: 'tail', fields: {}, inputs: {} }, data: 'edge' },
}] }, variables: [{ id: 'v1', name: 'value', type: '' }], customWorkspaceState: { folded: true } });
async function projection() {
  const page = workspace();
  const document = { pages: [{ id: 'one', content: page, viewState: { scale: 0.8 } },
    { id: 'two', content: { blocks: { blocks: [{ id: 'other', type: 'root', comment: '另一页' }] } } }], activePageId: 'one' };
  return createAbsProjection(page, { document, generation: 'g1', baselineRef: 'baselines/g1.json',
    scope: { projectKey: 'p', pageId: 'one' }, savedAbiHash: null });
}

describe('complete ABS project state', () => {
  it('copies only each node residual instead of repeatedly cloning all descendants', async () => {
    let root: any;
    for (let i = 0; i < 128; i++) root = { type: 'statement', id: 'b' + i,
      fields: {}, ...(root ? { next: { block: root } } : {}) };
    const page = { blocks: { blocks: [root] } }, bytes = absJson(page).length;
    const parse = spyOn(JSON, 'parse').and.callThrough();
    const projected = await createAbsProjection(page, { document: page, generation: 'chain', baselineRef: 'baselines/chain.json',
      scope: { projectKey: 'p', pageId: 'one' }, savedAbiHash: null });
    const parsed = parse.calls.allArgs().reduce((sum, args) => sum + String(args[0]).length, 0);
    expect(parsed).toBeLessThan(bytes * 8);
    expect(absJson((await decodeAbsState(projected.abs)).workspace)).toBe(absJson(page));
  });
  it('decodes long statement chains without a recursive builder', async () => {
    let root: any = { type: 'statement', id: 'tail' };
    for (let i = 0; i < 1200; i++) root = { type: 'statement', id: 'b' + i, next: { block: root } };
    const page = { blocks: { blocks: [{ type: 'root', id: 'root', inputs: { DO: { block: root } } }] } };
    const projection = await createAbsProjection(page, { document: page, generation: 'deep', baselineRef: 'baselines/deep.json',
      scope: { projectKey: 'p', pageId: 'one' }, savedAbiHash: null,
      contracts: { fields: { root: {} }, syntax: { root: [{ kind: 'statementInput', name: 'DO' }] } } });
    expect(absJson((await decodeAbsState(projection.abs)).workspace)).toBe(absJson(page));
  });
  it('stores node residuals in linear preorder and verifies legacy complete snapshots byte-for-byte', async () => {
    const current = await projection(), body = splitAbsState(current.abs).program;
    const index = indexAbsAbi(current.workspace);
    const blocks = new Map(current.map.nodes.map(node => [node.astPath, index.get(node.blockId)!]));
    const legacy = await encodeAbsState(body, current.document, blocks, current.contracts, current.workspace, true);
    expect(JSON.parse(splitAbsState(current.abs).state!).version).toBe(2);
    expect(Array.isArray(JSON.parse(splitAbsState(current.abs).state!).nodes)).toBeTrue();
    const decoded = await decodeAbsState(legacy);
    const restored = await reconstructAbsProjection(decoded.workspace, { ...current.map,
      document: decoded.document, contracts: decoded.contracts }, legacy);
    expect(restored.map.projectionVersion).toBe('abs-v2.preview.7');
    expect(restored.abs).toBe(legacy); await validateAbsProjection(restored);
    expect(absJson(decoded.document)).toBe(absJson(current.document));
    expect((await createAbsProjection(decoded.workspace, { ...current.map,
      document: decoded.document, contracts: decoded.contracts })).map.projectionVersion).toBe('abs-v2.preview.8');
  });
  it('restores comments, dormant shadows, protection, disabled reasons, pages and opaque state exactly', async () => {
    const original = await projection();
    const decoded = await decodeAbsState(original.abs);
    expect(absJson(decoded.document)).toBe(absJson(original.document));
    expect(absJson(decoded.workspace)).toBe(absJson(original.workspace));
    expect(original.abs.split('visible-value-once').length - 1).toBe(1);
    await validateAbsProjection(original);
  });
  it('recreates the complete projection from ABS and small generation context alone', async () => {
    const original = await projection();
    const decoded = await decodeAbsState(original.abs);
    const restored = await createAbsProjection(decoded.workspace, { ...original.map, document: decoded.document, contracts: decoded.contracts });
    expect(restored.abs).toBe(original.abs);
    expect(absMapJson(restored.map)).toBe(absMapJson(original.map));
  });
  it('uses the project document as the sole owner of shared model state', async () => {
    const page = workspace();
    const { variables, ...content } = page;
    const document = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'], pages: [{ id: 'main', title: 'Main', content }],
      sharedModel: { procedureBlocks: [], variables } };
    const baseline = await createAbsProjection(page, { document, generation: 'owned', baselineRef: 'baselines/owned.json', scope: { projectKey: 'p', pageId: 'main' }, savedAbiHash: null });
    const state = JSON.parse(splitAbsState(baseline.abs).state!);
    expect(state.workspace).toBeUndefined(); expect(state.workspacePage).toBe('main');
    expect(absJson((await decodeAbsState(baseline.abs)).workspace)).toBe(absJson(page));
  });
  it('distinguishes an ordinary draft from a complete restorable snapshot', async () => {
    const baseline = await projection();
    const edited = baseline.abs.replace('visible-value-once', 'changed');
    expect(() => assertAbsStateUnchanged(edited, baseline.abs)).not.toThrow();
    expect(() => assertAbsStateUnchanged(edited + '\n# ordinary trailing comment', baseline.abs)).not.toThrow();
    await expectAsync(decodeAbsState(edited)).toBeRejected();
  });
  it('allows plain source while refusing replacement or duplicate state metadata', async () => {
    const baseline = await projection();
    expect(() => assertAbsStateUnchanged(splitAbsState(baseline.abs).program, baseline.abs)).not.toThrow();
    expect(() => assertAbsStateUnchanged(baseline.abs.replace('MANUALLY_DISABLED', 'unlocked'), baseline.abs)).toThrow();
    expect(() => splitAbsState(baseline.abs + '\n# @project-state:{}')).toThrow();
  });
  it('preserves symbol serialization without storing a second visible program', async () => {
    const page: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'get', id: 'g', fields: { VAR: { id: 'v' } } }] }, variables: [{ id: 'v', name: '名字', type: '' }] };
    const baseline = await createAbsProjection(page, { document: page, generation: 'symbols', baselineRef: 'baselines/symbols.json', scope: { projectKey: 'p', pageId: 'one' }, savedAbiHash: null,
      contracts: { fields: { g: { VAR: { type: 'field_variable', symbol: { kind: 'variable', storage: 'variable-state' } } } } } });
    expect(absJson((await decodeAbsState(baseline.abs)).document)).toBe(absJson(page));
  });
});
