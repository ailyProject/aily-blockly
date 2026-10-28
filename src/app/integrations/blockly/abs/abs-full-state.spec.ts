import { createAbsProjection, absJson, validateAbsProjection } from './abs-identity-map';
import { assertAbsStateUnchanged, decodeAbsState, splitAbsState } from './abs-full-state';
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
    expect(absJson(restored.map)).toBe(absJson(original.map));
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
