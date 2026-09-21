import * as Blockly from 'blockly';
import '../../../editors/blockly-editor/components/blockly/plugins/block-plus-minus/src/index.js';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { captureAbsDeclarativeContracts } from './abs-declarative-contracts';
import { captureAbsWorkspaceState, assertAbsRuntimeShapeSupported } from './abs-workspace-state';
import { absJson, createAbsProjection } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { assertAbsReadback } from './abs-readback';
import { describeAbsBlockCapability } from './abs-block-capabilities';

describe('shared structural mutator preparation', () => {
  let workspace: Blockly.Workspace, catalog: BlocklyDeclarativeBlockCatalog, oldBlockly: unknown;
  const names: string[] = [];
  const arg = (name: string, type = 'input_value') => ({ type, name });
  function declare(type: string, mutator: string | undefined, args: any[], output = false) {
    const json = { type, message0: args.map((_, index) => '%' + (index + 1)).join(' '), args0: args,
      ...(mutator ? { mutator } : {}), ...(output ? { output: null } : { previousStatement: null, nextStatement: null }) };
    Blockly.defineBlocksWithJsonArray([json]); catalog.record(json, Blockly.Blocks[type]); names.push(type);
  }
  const capture = () => captureAbsWorkspaceState(workspace, () => {}, catalog.capture(Blockly.Blocks));
  const projection = async () => {
    const runtime = capture();
    return createAbsProjection(runtime.state, { document: runtime.state, contracts: runtime.contracts,
      generation: 'g', baselineRef: 'base', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
  };
  async function edit(source: string, base?: Awaited<ReturnType<typeof projection>>) {
    base ??= await projection();
    const definitions = catalog.capture(Blockly.Blocks), shapes = captureAbsDeclarativeContracts(definitions);
    const result = await reconcileAbsDraft(base, source, {
      argumentOrder: (type, state) => shapes.get(type, state)?.argumentOrder,
      fieldDefinition: (type, name, id) => id ? base.contracts.fields[id]?.[name] : shapes.get(type)?.fields[name],
      blockContract: shapes.get,
    });
    assertAbsRuntimeShapeSupported(base.workspace, result.workspace, result.contracts, shapes.get);
    Blockly.serialization.workspaces.load(result.workspace, workspace);
    const actual = capture(); assertAbsReadback(result.workspace, actual.state, actual);
    return result;
  }
  beforeEach(() => {
    oldBlockly = window['Blockly']; window['Blockly'] = Blockly;
    workspace = new Blockly.Workspace(); catalog = new BlocklyDeclarativeBlockCatalog();
    declare('abs_s_number', undefined, [{ type: 'field_number', name: 'NUM', value: 0 }], true);
    declare('abs_s_if', 'controls_if_mutator', [arg('IF0'), arg('DO0', 'input_statement')]);
    declare('abs_s_ifelse', 'controls_if_mutator', [arg('IF0'), arg('DO0', 'input_statement'), arg('ELSE', 'input_statement')]);
    declare('abs_s_switch', 'switch_case_mutator', [arg('SWITCH'), arg('CASE0'), arg('DO0', 'input_statement'), arg('DEFAULT', 'input_statement')]);
    declare('abs_s_values', 'dynamic_inputs_mutator', [arg('INPUT0')], true);
    declare('abs_s_join', 'text_join_mutator', [], true);
    declare('abs_s_list', 'new_list_create_with_mutator', [arg('EMPTY', 'input_dummy')], true);
  });
  afterEach(() => { workspace.dispose(); window['Blockly'] = oldBlockly; for (const type of names.splice(0)) delete Blockly.Blocks[type]; });

  for (const [type, state] of [
    ['abs_s_if', { elseIfCount: 2, hasElse: true }], ['abs_s_ifelse', { hasElse: false }],
    ['abs_s_switch', { caseCount: 3, hasDefault: false }], ['abs_s_values', { extraCount: 4 }],
    ['abs_s_join', { itemCount: 0 }], ['abs_s_join', { itemCount: 4 }], ['abs_s_list', { itemCount: 0 }],
  ] as const) it(`prepares ${type} ${JSON.stringify(state)} and matches actual native restoration`, async () => {
    const probe = spyOn(Blockly.Workspace.prototype, 'newBlock').and.callThrough();
    const snapshot = catalog.capture(Blockly.Blocks), shape = captureAbsDeclarativeContracts(snapshot).get(type, state)!;
    expect(shape).toBeDefined(); expect(probe).not.toHaveBeenCalled();
    expect(describeAbsBlockCapability(snapshot, type).level).toBe('reshape');
    await edit('# ABS Schema: 2\n' + type + '() @extra:' + JSON.stringify(state));
    const block = workspace.getBlocksByType(type, false)[0];
    expect(block.inputList.filter(input => !!input.connection).map(input => input.name)).toEqual(Object.keys(shape.inputs));
    expect(block.saveExtraState?.() ?? undefined).toEqual(shape.extraState);
  });

  it('creates, reshapes and repeats edits with the same block/child identities and original parameter order', async () => {
    await edit('# ABS Schema: 2\nabs_s_switch(abs_s_number(7), abs_s_number(1), abs_s_number(2)) @extra:{"caseCount":1,"hasDefault":false}');
    const first = await projection(), id = workspace.getBlocksByType('abs_s_switch', false)[0].id;
    const numberIds = workspace.getBlocksByType('abs_s_number', false).map(block => block.id).sort();
    await edit(first.abs.replace('"caseCount":1', '"caseCount":2'), first);
    const second = await projection();
    expect(second.abs).toContain('abs_s_switch(abs_s_number(7), abs_s_number(1), abs_s_number(2), null)');
    await edit(second.abs.replace('abs_s_number(7)', 'abs_s_number(8)'), second);
    expect(workspace.getBlocksByType('abs_s_switch', false)[0].id).toBe(id);
    expect(workspace.getBlocksByType('abs_s_number', false).map(block => block.id).sort()).toEqual(numberIds);
  });

  for (const [call, type, state] of [
    ['abs_s_join()', 'abs_s_join', { itemCount: 0 }],
    ['abs_s_join(abs_s_number(1))', 'abs_s_join', { itemCount: 1 }],
    ['abs_s_join(ADD0=abs_s_number(1), ADD1=abs_s_number(2), ADD2=abs_s_number(3))', 'abs_s_join', { itemCount: 3 }],
    ['abs_s_list(abs_s_number(1), abs_s_number(2))', 'abs_s_list', { itemCount: 2 }],
    ['abs_s_values(abs_s_number(1), INPUT1=abs_s_number(2))', 'abs_s_values', { extraCount: 1 }],
    ['abs_s_if(abs_s_number(1), abs_s_number(0))\n    @DO1:\n    @ELSE:', 'abs_s_if', { elseIfCount: 1, hasElse: true }],
    ['abs_s_switch(abs_s_number(7), abs_s_number(1), abs_s_number(2))\n    @DO1:', 'abs_s_switch', { caseCount: 1, hasDefault: true }],
  ] as const) it(`infers only bundled repeated slots from README shorthand: ${call}`, async () => {
    await edit('# ABS Schema: 2\n' + call);
    const block = workspace.getBlocksByType(type, false)[0];
    expect(block.saveExtraState?.()).toEqual(state);
    const exported = await projection();
    await edit(exported.abs + '\n# canonical readback', exported);
    expect(workspace.getBlockById(block.id)?.saveExtraState?.()).toEqual(state);
  });

  it('shrinks a previously expanded shape when the shorthand omits its extra state', async () => {
    await edit('# ABS Schema: 2\nabs_s_if(abs_s_number(1), abs_s_number(0))\n    @DO1:\n    @ELSE:');
    const id = workspace.getBlocksByType('abs_s_if', false)[0].id;
    await edit('# ABS Schema: 2\nabs_s_if(abs_s_number(1))');
    expect(workspace.getBlockById(id)?.getInput('IF1')).toBeNull();
    expect(workspace.getBlockById(id)?.getInput('ELSE')).toBeNull();
  });

  it('keeps explicit counts authoritative and rejects duplicate README assignments and gaps', async () => {
    const before = absJson(capture().state);
    for (const call of [
      'abs_s_if(abs_s_number(1))\n    @IF0: abs_s_number(2)',
      'abs_s_if(abs_s_number(1))\n    @DO2:',
      'abs_s_join(ADD1=abs_s_number(1))',
      'abs_s_join(abs_s_number(1), abs_s_number(2)) @extra:{"itemCount":1}',
    ]) {
      await expectAsync(edit('# ABS Schema: 2\n' + call)).toBeRejected();
      expect(absJson(capture().state)).toBe(before);
    }
    await edit('# ABS Schema: 2\nabs_s_values(INPUT3=abs_s_number(3)) @extra:{"extraCount":3}');
    expect(workspace.getBlocksByType('abs_s_values', false)[0].getInputTargetBlock('INPUT3')?.getFieldValue('NUM')).toBe(3);
  });

  it('uses each instance state rather than borrowing another instance argument count', async () => {
    await edit('# ABS Schema: 2\nabs_s_values(abs_s_number(1))\nabs_s_values(abs_s_number(2), abs_s_number(3)) @extra:{"extraCount":1}');
    const base = await projection();
    expect(base.abs).toContain('abs_s_values(abs_s_number(1))');
    expect(base.abs).toContain('abs_s_values(abs_s_number(2), abs_s_number(3))');
    await edit(base.abs.replace('abs_s_number(3)', 'abs_s_number(4)'), base);
  });

  it('rejects unknown keys, invalid counts, impossible slots and replaced registrations without mutation', async () => {
    const before = absJson(capture().state), shapes = captureAbsDeclarativeContracts(catalog.capture(Blockly.Blocks));
    for (const state of [{ extraCount: -1 }, { extraCount: 1.5 }, { extraCount: 1025 }, { extraCount: null }, { extraCount: '2' }, { extraCount: 1, typo: true }]) {
      expect(() => shapes.get('abs_s_values', state)).toThrow();
    }
    expect(() => shapes.get('abs_s_if', { hasElse: null })).toThrow();
    await expectAsync(edit('# ABS Schema: 2\nabs_s_values(INPUT99=abs_s_number(2))')).toBeRejected();
    expect(absJson(capture().state)).toBe(before);
    const registry = (Blockly.Extensions as any).TEST_ONLY.allExtensions, original = registry.dynamic_inputs_mutator;
    expect(shapes.get('abs_s_values')).toBeDefined();
    try { registry.dynamic_inputs_mutator = () => {}; expect(() => shapes.assertCurrent()).toThrow(); }
    finally { registry.dynamic_inputs_mutator = original; }
  });
});
