import * as Blockly from 'blockly';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { captureAbsDeclarativeContracts } from './abs-declarative-contracts';
import { captureAbsWorkspaceState, assertAbsRuntimeShapeSupported, loadAbsWorkspaceState } from './abs-workspace-state';
import { createAbsProjection, absJson } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { assertAbsReadback } from './abs-readback';
import { absSyntaxOptions } from './abs-syntax-contracts';
import type { AbsAbiWorkspace } from './abs-state';

describe('unproven field-shape serialization uses native preservation', () => {
  const type = 'abs_opaque_shape', valueType = 'abs_opaque_number';
  const json = { type, message0: '%1 %2', args0: [
    { type: 'field_dropdown', name: 'PROPERTY', options: [['divisible', 'DIVISIBLE_BY'], ['prime', 'PRIME']] },
    { type: 'input_value', name: 'NUMBER_TO_CHECK' },
  ], output: 'Boolean', mutator: 'math_is_divisibleby_mutator' };
  let workspace: Blockly.Workspace, catalog: BlocklyDeclarativeBlockCatalog, oldBlockly: unknown;
  const capture = () => captureAbsWorkspaceState(workspace, () => {}, catalog.capture(Blockly.Blocks));

  beforeEach(() => {
    oldBlockly = window['Blockly']; window['Blockly'] = Blockly;
    workspace = new Blockly.Workspace(); catalog = new BlocklyDeclarativeBlockCatalog();
    Blockly.Blocks[type] = { init() {
      this.jsonInit(json);
      this.payload = { note: 'retain 界😀', values: [1, null, false] };
      this.saveExtraState = function () { return { divisor: !!this.getInput('DIVISOR'), payload: this.payload }; };
      this.loadExtraState = function (state) {
        this.payload = state.payload;
        const mutation = Blockly.utils.xml.createElement('mutation');
        mutation.setAttribute('divisor_input', String(state.divisor));
        this.domToMutation(mutation);
      };
    } };
    catalog.record(json, Blockly.Blocks[type]);
    const number = { type: valueType, message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 7 }], output: 'Number' };
    Blockly.defineBlocksWithJsonArray([number]); catalog.record(number, Blockly.Blocks[valueType]);
  });
  afterEach(() => { workspace.dispose(); delete Blockly.Blocks[type]; delete Blockly.Blocks[valueType]; window['Blockly'] = oldBlockly; });

  function existing(disabled = false) {
    const block = workspace.newBlock(type, 'opaque-parent');
    block.setFieldValue('PRIME', 'PROPERTY'); block.setFieldValue('DIVISIBLE_BY', 'PROPERTY');
    block.setDeletable(false); block.setCollapsed(true); block.setDisabledReason(disabled, 'MANUALLY_DISABLED');
    for (const [name, id, n] of [['NUMBER_TO_CHECK', 'kept-number', 7], ['DIVISOR', 'kept-divisor', 2]] as const) {
      const child = workspace.newBlock(valueType, id); child.setFieldValue(n, 'NUM');
      block.getInput(name)!.connection!.connect(child.outputConnection!);
    }
    return block;
  }
  async function projection() {
    const runtime = capture();
    return createAbsProjection(runtime.state, { document: runtime.state, contracts: runtime.contracts,
      generation: 'opaque-shape-generation', baselineRef: 'base', savedAbiHash: null,
      scope: { projectKey: 'opaque-shape-private', pageId: 'main' } });
  }

  it('declines opaque JSON without caching failure or replacing the proven XML shape', () => {
    const shapes = captureAbsDeclarativeContracts(catalog.capture(Blockly.Blocks));
    const extra = { divisor: true, payload: { note: 'opaque' } }, before = absJson(extra);
    expect(shapes.get(type, extra, { PROPERTY: 'DIVISIBLE_BY' })).toBeUndefined();
    expect(absJson(extra)).toBe(before);
    const xml = '<mutation divisor_input="true"></mutation>';
    expect(shapes.get(type, xml, { PROPERTY: 'DIVISIBLE_BY' })?.extraState).toBe(xml);
    expect(shapes.get(type, undefined, { PROPERTY: 'PRIME' })?.inputs['DIVISOR']).toBeUndefined();
    expect(shapes.get(type, extra, { PROPERTY: 'PRIME' })).toBeUndefined();
  });

  for (const disabled of [false, true]) it(`exports, edits and natively reloads ${disabled ? 'disabled' : 'enabled'} opaque state without data or protection loss`, async () => {
    existing(disabled);
    const baseline = await projection(), before = absJson(capture().state);
    const shapes = captureAbsDeclarativeContracts(catalog.capture(Blockly.Blocks));
    const edited = baseline.abs.replace(`${valueType}(7)`, `${valueType}(9)`);
    expect(edited).not.toBe(baseline.abs);
    const draft = await reconcileAbsDraft(baseline, edited, {
      blockContract: shapes.get,
      argumentOrder: (blockType, extra, fields) => shapes.get(blockType, extra, fields)?.argumentOrder,
      fieldSelectors: blockType => shapes.get(blockType)?.fieldShape?.map(rule => rule.field),
      fieldDefinition: (blockType, field) => shapes.get(blockType)?.fields[field],
    });
    assertAbsRuntimeShapeSupported(baseline.workspace, draft.workspace, draft.contracts, shapes.get);
    expect(absJson(capture().state)).toBe(before);
    await loadAbsWorkspaceState(draft.workspace, workspace as any, {}, () => {}, draft.contracts);
    const actual = capture(); assertAbsReadback(draft.workspace, actual.state, actual);
    const block = workspace.getBlockById('opaque-parent')!;
    expect(block.saveExtraState!()).toEqual({ divisor: true, payload: { note: 'retain 界😀', values: [1, null, false] } });
    expect(block.isEnabled()).toBe(!disabled); expect(block.isCollapsed()).toBeTrue(); expect(block.isDeletable()).toBeFalse();
    expect(workspace.getBlockById('kept-number')!.getFieldValue('NUM')).toBe(9);
    expect(workspace.getBlockById('kept-divisor')!.getFieldValue('NUM')).toBe(2);
    expect(actual.contracts.syntax!['opaque-parent'].map(arg => arg.name)).toEqual(['PROPERTY', 'NUMBER_TO_CHECK', 'DIVISOR']);
  });

  it('does not turn decline into permission to reshape opaque state or drop its payload', async () => {
    existing();
    const baseline = await projection(), captured = capture();
    const shapes = captureAbsDeclarativeContracts(catalog.capture(Blockly.Blocks));
    const syntax = absSyntaxOptions(baseline.workspace, baseline.contracts, {
      fieldSelectors: blockType => shapes.get(blockType)?.fieldShape?.map(rule => rule.field),
      argumentOrder: (blockType, extra, fields) => shapes.get(blockType, extra, fields)?.argumentOrder,
    });
    expect(syntax.argumentOrder!(type, baseline.workspace.blocks.blocks[0].extraState, { PROPERTY: 'PRIME' })).toBeUndefined();
    expect(syntax.argumentOrder!(type, { divisor: true, payload: { different: true } }, { PROPERTY: 'DIVISIBLE_BY' })).toBeUndefined();
    const changed = structuredClone(baseline.workspace);
    changed.blocks.blocks[0].extraState = { divisor: true };
    expect(() => assertAbsRuntimeShapeSupported(baseline.workspace, changed, baseline.contracts, shapes.get)).toThrow();
    changed.blocks.blocks[0].extraState = baseline.workspace.blocks.blocks[0].extraState;
    changed.blocks.blocks[0].fields!['PROPERTY'] = 'PRIME';
    expect(() => assertAbsRuntimeShapeSupported(baseline.workspace, changed, baseline.contracts, shapes.get)).toThrow();
    const actual = structuredClone(captured.state);
    (actual.blocks.blocks[0].extraState as any).payload.values.pop();
    expect(() => assertAbsReadback(captured.state, actual, captured)).toThrowMatching(error => error.code === 'ABS_READBACK_MISMATCH');
  });

  it('still rejects an unprepared new opaque instance instead of trusting its extraState', () => {
    const shapes = captureAbsDeclarativeContracts(catalog.capture(Blockly.Blocks));
    const candidate: AbsAbiWorkspace = { blocks: { blocks: [{ id: 'unprepared', type, fields: { PROPERTY: 'DIVISIBLE_BY' },
      extraState: { divisor: true, payload: { value: 7 } } }] } };
    expect(() => assertAbsRuntimeShapeSupported({ blocks: { blocks: [] } }, candidate, { fields: {} }, shapes.get))
      .toThrowMatching(error => error.code === 'ABS_RUNTIME_SHAPE_UNSUPPORTED');
  });

  it('keeps strict JSON rejection separate from optimization eligibility', () => {
    const shapes = captureAbsDeclarativeContracts(catalog.capture(Blockly.Blocks));
    for (const extra of [new Date(0), new Map(), new (class State { value = 1; })(), { value: Infinity }]) {
      expect(shapes.get(type, extra)).toBeUndefined();
      expect(() => absJson({ extraState: extra })).toThrow();
    }
  });

  it('does not swallow native metadata or declaration callback failures', () => {
    existing();
    const definitions = catalog.capture(Blockly.Blocks);
    expect(() => captureAbsWorkspaceState(workspace, () => {}, { ...definitions,
      nativeStructure: () => { throw new Error('native metadata failure'); } })).toThrowError('native metadata failure');
    expect(() => captureAbsWorkspaceState(workspace, () => {}, { ...definitions,
      get: () => { throw new Error('declaration changed'); } })).toThrowError('declaration changed');
  });
});
