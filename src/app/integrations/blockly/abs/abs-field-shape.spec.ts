import * as Blockly from 'blockly';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { captureAbsDeclarativeContracts } from './abs-declarative-contracts';
import { captureAbsWorkspaceState, assertAbsRuntimeShapeSupported } from './abs-workspace-state';
import { createAbsProjection, absJson, validateAbsProjection } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { assertAbsReadback } from './abs-readback';
import { describeAbsBlockCapability } from './abs-block-capabilities';

describe('field-dependent input preparation', () => {
  let workspace: Blockly.Workspace, catalog: BlocklyDeclarativeBlockCatalog, oldBlockly: unknown;
  const types: string[] = [];
  function declare(type: string, args0: any[], mutator?: string) {
    const json = { type, args0, message0: args0.map((_, i) => '%' + (i + 1)).join(' '), output: null, ...(mutator ? { mutator } : {}) };
    Blockly.defineBlocksWithJsonArray([json]); catalog.record(json, Blockly.Blocks[type]); types.push(type);
  }
  const capture = () => captureAbsWorkspaceState(workspace, () => {}, catalog.capture(Blockly.Blocks));
  async function projection() {
    const runtime = capture();
    return createAbsProjection(runtime.state, { document: runtime.state, contracts: runtime.contracts,
      generation: 'field-g', baselineRef: 'base', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
  }
  async function edit(text: string) {
    const baseline = await projection(), shapes = captureAbsDeclarativeContracts(catalog.capture(Blockly.Blocks));
    const before = absJson(capture().state);
    const result = await reconcileAbsDraft(baseline, text, { blockContract: shapes.get,
      argumentOrder: (type, extra, fields) => shapes.get(type, extra, fields)?.argumentOrder,
      fieldSelectors: type => shapes.get(type)?.fieldShape?.map(rule => rule.field),
      fieldDefinition: (type, name) => shapes.get(type)?.fields[name] });
    assertAbsRuntimeShapeSupported(baseline.workspace, result.workspace, result.contracts, shapes.get);
    expect(absJson(capture().state)).toBe(before);
    Blockly.serialization.workspaces.load(result.workspace, workspace);
    const actual = capture(); assertAbsReadback(result.workspace, actual.state, actual);
    return result;
  }
  beforeEach(() => {
    oldBlockly = window['Blockly']; window['Blockly'] = Blockly;
    workspace = new Blockly.Workspace(); catalog = new BlocklyDeclarativeBlockCatalog();
    declare('abs_f_num', [{ type: 'field_number', name: 'NUM', value: 0 }]);
    declare('abs_f_text', [{ type: 'field_input', name: 'TEXT', text: '' }]);
    declare('abs_f_property', [{ type: 'input_value', name: 'NUMBER_TO_CHECK' },
      { type: 'field_dropdown', name: 'PROPERTY', options: [['even', 'EVEN'], ['divisible', 'DIVISIBLE_BY']] }], 'math_is_divisibleby_mutator');
    declare('abs_f_char', [{ type: 'input_value', name: 'VALUE' }, { type: 'field_dropdown', name: 'WHERE',
      options: [['start', 'FROM_START'], ['end', 'FROM_END'], ['first', 'FIRST'], ['last', 'LAST']] }], 'text_charAt_mutator');
  });
  afterEach(() => { workspace.dispose(); window['Blockly'] = oldBlockly; for (const type of types.splice(0)) delete Blockly.Blocks[type]; });
  it('creates multiple native shapes without handwritten extraState or probing and preserves native XML on export', async () => {
    const probe = spyOn(Blockly.Workspace.prototype, 'newBlock').and.callThrough();
    const snapshot = catalog.capture(Blockly.Blocks);
    expect(describeAbsBlockCapability(snapshot, 'abs_f_property')).toEqual(jasmine.objectContaining({ contract: 'field-shape-v1' }));
    expect(probe).not.toHaveBeenCalled();
    await edit('# ABS Schema: 2\nabs_f_property(abs_f_num(8), DIVISIBLE_BY, abs_f_num(2))\nabs_f_char(abs_f_text("abc"), LAST)\nabs_f_char(abs_f_text("def"), FROM_START, abs_f_num(1))');
    const baseline = await projection();
    expect(baseline.abs).toContain('@extra'); expect(baseline.abs).not.toContain('WHERE=');
    await validateAbsProjection(baseline);
    await edit(baseline.abs);
  });
  it('adds and removes conditional inputs across edits while preserving parent and surviving child IDs', async () => {
    await edit('# ABS Schema: 2\nabs_f_property(abs_f_num(8), EVEN)');
    const before = await projection(), id = workspace.getBlocksByType('abs_f_property', false)[0].id;
    const numberId = workspace.getBlocksByType('abs_f_num', false)[0].id;
    await edit(before.abs.replace('EVEN)', 'DIVISIBLE_BY, abs_f_num(2))'));
    expect(workspace.getBlockById(id)!.getInput('DIVISOR')).toBeTruthy();
    const added = await projection();
    await edit(added.abs.replace('DIVISIBLE_BY, abs_f_num(2)', 'EVEN'));
    expect(workspace.getBlockById(id)!.getInput('DIVISOR')).toBeNull(); expect(workspace.getBlockById(numberId)).toBeTruthy();
    expect(workspace.getBlocksByType('abs_f_num', false).length).toBe(1);
  });
  it('resolves named selectors regardless of their position and rejects contradictory or unproved shapes', async () => {
    await edit('# ABS Schema: 2\nabs_f_property(DIVISOR=abs_f_num(2), PROPERTY=DIVISIBLE_BY, NUMBER_TO_CHECK=abs_f_num(8))');
    const before = absJson(capture().state);
    for (const source of ['abs_f_property(abs_f_num(8), EVEN, abs_f_num(2))',
      'abs_f_char(abs_f_text("abc"), FIRST, abs_f_num(1))', 'abs_f_char(null, UNKNOWN)',
      'abs_f_property(null, EVEN) @extra:{"divisorInput":true}',
      'abs_f_property(null, EVEN) @extra:"<mutation divisor_input=\\"false\\" other=\\"lost\\"></mutation>"']) {
      await expectAsync(edit('# ABS Schema: 2\n' + source)).toBeRejected(); expect(absJson(capture().state)).toBe(before);
    }
  });
  it('refuses an overridden native registration', () => {
    const snapshot = catalog.capture(Blockly.Blocks), shapes = captureAbsDeclarativeContracts(snapshot);
    expect(shapes.get('abs_f_property')).toBeDefined();
    const registry = (Blockly.Extensions as any).TEST_ONLY.allExtensions, original = registry.math_is_divisibleby_mutator;
    try { registry.math_is_divisibleby_mutator = () => {}; expect(() => snapshot.assertCurrent()).toThrow(); }
    finally { registry.math_is_divisibleby_mutator = original; }
  });
  it('removes dormant and visible shadows only when the proven slot itself is removed', async () => {
    Blockly.serialization.workspaces.load({ blocks: { blocks: [{ type: 'abs_f_property', id: 'property-shadow',
      fields: { PROPERTY: 'DIVISIBLE_BY' }, extraState: '<mutation divisor_input="true"></mutation>', inputs: {
        NUMBER_TO_CHECK: { shadow: { type: 'abs_f_num', id: 'retained-shadow', fields: { NUM: 8 } } },
        DIVISOR: { shadow: { type: 'abs_f_num', id: 'dormant-shadow', fields: { NUM: 1 } },
          block: { type: 'abs_f_num', id: 'removed-child', fields: { NUM: 2 } } },
      } }] } }, workspace);
    await edit('# ABS Schema: 2\nabs_f_property(abs_f_num(8), EVEN)');
    expect(workspace.getBlockById('property-shadow')!.getInput('DIVISOR')).toBeNull();
    expect(workspace.getBlockById('retained-shadow')!.isShadow()).toBeTrue();
    expect(workspace.getBlockById('dormant-shadow')).toBeNull();
  });
});
