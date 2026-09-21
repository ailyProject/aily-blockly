import * as Blockly from 'blockly';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { captureAbsBundledProcedures } from './abs-bundled-procedures';
import { absJson, createAbsProjection, indexAbsAbi } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { captureAbsWorkspaceState, assertAbsRuntimeShapeSupported } from './abs-workspace-state';
import { assertAbsReadback } from './abs-readback';
import { AbsAbiWorkspace } from './abs-state';
import { adaptBundledArduinoProcedureCalls } from '../../../editors/blockly-editor/services/blockly-bundled-procedure-generator';
import { captureBlocklyRootClassifier } from '../../../editors/blockly-editor/services/blockly-root-role';
import { captureAbsPageReferenceContract } from './abs-runtime-references';

describe('host-bundled procedure candidate preparation', () => {
  let workspace: Blockly.Workspace, oldBlockly: unknown;
  const capture = () => captureAbsWorkspaceState(workspace, () => {});
  const snapshot = () => new BlocklyDeclarativeBlockCatalog().capture(Blockly.Blocks);
  const project = async () => {
    const { state, contracts } = capture();
    return createAbsProjection(state, { document: state, contracts, generation: 'g', baselineRef: 'r',
      savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
  };
  const prepare = async (source: (abs: string) => string, variables?: string[]) => {
    const base = await project(), adapter = captureAbsBundledProcedures(snapshot());
    const result = await reconcileAbsDraft(base, source(base.abs), { prepareBlock: adapter.prepare,
      ...(variables ? { variableCreation: { requestId: 'procedure-test-0001', variables: variables.map(name => ({ name })) } } : {}) });
    assertAbsRuntimeShapeSupported(base.workspace, result.workspace, result.contracts, adapter.get);
    return result;
  };
  const load = (state: AbsAbiWorkspace) => {
    Blockly.serialization.workspaces.load(state, workspace);
    const actual = capture();
    assertAbsReadback(state, actual.state, actual);
  };
  beforeEach(() => {
    oldBlockly = window['Blockly']; window['Blockly'] = Blockly;
    workspace = new Blockly.Workspace(); Blockly.Events.disable();
  });
  afterEach(() => { workspace.dispose(); Blockly.Events.enable(); window['Blockly'] = oldBlockly; });

  it('creates a definition and caller without parameters from an empty workspace', async () => {
    const result = await prepare(abs => abs + '\nprocedures_defnoreturn(NAME="work")\nprocedures_callnoreturn() @extra:{"name":"work"}');
    load(result.workspace);
    expect(Object.keys(result.contracts.procedures!).length).toBe(2);
  });
  it('prepares parameter variable and UI identities, then completely reads back native serialization', async () => {
    const result = await prepare(abs => abs + '\nprocedures_defreturn(NAME="work") @extra:{"params":[{"name":"amount"}]}\nprocedures_callreturn() @extra:{"name":"work","params":["amount"]}', ['amount']);
    const definition = result.workspace.blocks.blocks[0], param = (definition.extraState as any).params[0];
    expect(param.id).toBe('abs-variable:procedure-test-0001:0'); expect(param.argId).toBe('abs_arg_0');
    expect(definition.fields![param.argId]).toBe('amount');
    load(result.workspace);
    expect(workspace.getAllVariables().length).toBe(1);
  });
  it('adds and removes parameters while retaining definition/call IDs and surviving parameter IDs', async () => {
    load((await prepare(abs => abs + '\nprocedures_defnoreturn(NAME="work")\nprocedures_callnoreturn() @extra:{"name":"work"}')).workspace);
    const initial = capture().state;
    const added = await prepare(abs => abs.replace('procedures_defnoreturn(NAME="work")', 'procedures_defnoreturn(NAME="work") @extra:{"params":[{"name":"amount"}]}')
      .replace('"name":"work"}', '"name":"work","params":["amount"]}'), ['amount']);
    expect([...indexAbsAbi(added.workspace).keys()]).toEqual([...indexAbsAbi(initial).keys()]); load(added.workspace);
    const before = absJson(capture().state);
    load((await prepare(abs => abs + '\n# edit again')).workspace); expect(absJson(capture().state)).toBe(before);
    const removed = await prepare(abs => abs.replace(/@extra:\{"params":\[\{[^\n]+?\}\]\}/, '@extra:{"params":[]}').replace('"params":["amount"]', '"params":[]'));
    load(removed.workspace);
    expect(workspace.getAllVariables().length).toBe(1); // Signature removal never deletes shared models.
    expect(removed.workspace.blocks.blocks.find(block => block.type === 'procedures_defnoreturn')!.fields).toEqual({ NAME: 'work' });
  });
  it('rejects undeclared parameters, duplicate names, unknown serializer members and caller mismatch before loading', async () => {
    for (const suffix of [
      '\nprocedures_defnoreturn(NAME="work") @extra:{"params":[{"name":"missing"}]}',
      '\nprocedures_defnoreturn(NAME="work") @extra:{"hidden":true}',
      '\nprocedures_callnoreturn() @extra:{"name":"missing"}',
      '\nprocedures_defnoreturn(NAME="work")\nprocedures_defnoreturn(NAME="WORK")',
    ]) await expectAsync(prepare(abs => abs + suffix)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROCEDURE_INVALID' }));
    expect(workspace.getAllBlocks(false)).toEqual([]); expect(workspace.getAllVariables()).toEqual([]);
  });
  it('does not accept caller-supplied parameter IDs or UI field IDs', async () => {
    for (const identity of [{ argId: 'forged' }, { id: 'abs-variable:procedure-test-0001:0' }]) {
      await expectAsync(prepare(abs => abs + '\nprocedures_defnoreturn(NAME="work") @extra:' + JSON.stringify({ params: [{ name: 'amount', ...identity }] }), ['amount']))
        .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROCEDURE_INVALID' }));
    }
  });
  it('rejects same-name block replacement and registration changes after capture', () => {
    const catalog = snapshot(), original = Blockly.Blocks['procedures_defnoreturn'];
    expect(catalog.procedure!('procedures_defnoreturn')).toEqual({ role: 'definition', returns: false });
    try {
      Blockly.Blocks['procedures_defnoreturn'] = { ...original };
      expect(() => catalog.assertCurrent()).toThrow();
      expect(snapshot().procedure!('procedures_defnoreturn')).toBeUndefined();
    } finally { Blockly.Blocks['procedures_defnoreturn'] = original; }
  });
  it('classifies new definitions as shared before native loading and covers persisted parameter identities', async () => {
    const result = await prepare(abs => abs + '\nprocedures_defnoreturn(NAME="work") @extra:{"params":[{"name":"amount"}]}', ['amount']);
    expect(captureBlocklyRootClassifier(workspace, Blockly.Blocks)(result.workspace.blocks.blocks[0])).toBe('definition');
    load(result.workspace);
    expect(captureAbsPageReferenceContract(workspace, capture().state, () => {}).complete).toBeTrue();
  });
  it('adapts only native call input reads, preserving the actual library handler and workspace', async () => {
    load((await prepare(abs => abs + '\nprocedures_defnoreturn(NAME="work") @extra:{"params":[{"name":"amount"}]}\nprocedures_callnoreturn() @extra:{"name":"work","params":["amount"]}', ['amount'])).workspace);
    const caller = workspace.getAllBlocks(false).find(block => block.type === 'procedures_callnoreturn')!;
    const before = absJson(capture().state), native = caller.getInput('ARG0');
    const generator = { forBlock: { procedures_callnoreturn: (block: Blockly.Block) => [block.getInput('INPUT0'), block.getInput('ARG0'), block.getFieldValue('NAME')] } };
    adaptBundledArduinoProcedureCalls(generator); const wrapped = generator.forBlock.procedures_callnoreturn;
    adaptBundledArduinoProcedureCalls(generator); expect(generator.forBlock.procedures_callnoreturn).toBe(wrapped);
    expect(wrapped(caller)).toEqual([native, native, 'work']);
    expect(caller.getInput('INPUT0')).toBeNull(); expect(absJson(capture().state)).toBe(before);
    const original = Blockly.Blocks['procedures_callnoreturn'];
    try {
      Blockly.Blocks['procedures_callnoreturn'] = { ...original };
      expect(wrapped(caller)).toEqual([null, native, 'work']);
    } finally { Blockly.Blocks['procedures_callnoreturn'] = original; }
  });
  it('resolves both connection and target-block reads used by native CodeGenerator.valueToCode', async () => {
    load((await prepare(abs => abs + '\nprocedures_defnoreturn(NAME="work") @extra:{"params":[{"name":"amount"}]}\nprocedures_callnoreturn() @extra:{"name":"work","params":["amount"]}', ['amount'])).workspace);
    const caller = workspace.getAllBlocks(false).find(block => block.type === 'procedures_callnoreturn')!;
    const value = workspace.newBlock('math_number'); value.setFieldValue(9, 'NUM');
    caller.getInput('ARG0')!.connection!.connect(value.outputConnection!);
    const before = absJson(capture().state);
    const generator = new Blockly.CodeGenerator('native-input-test');
    generator.forBlock['math_number'] = block => [String(block.getFieldValue('NUM')), 0];
    generator.forBlock['procedures_callnoreturn'] = block => `work(${generator.valueToCode(block, 'INPUT0', 99)});`;
    adaptBundledArduinoProcedureCalls(generator);
    expect(generator.blockToCode(caller)).toBe('work(9);');
    expect(absJson(capture().state)).toBe(before);
  });
});
