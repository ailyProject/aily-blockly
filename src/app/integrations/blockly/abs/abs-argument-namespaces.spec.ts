import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { compileAbsDeclarativeContract } from './abs-declarative-contracts';
import { createAbsProjection } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { parseAbsSyntax } from './abs-syntax';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';
import type { AbsProjectionContracts } from './abs-state';

describe('ABS field and input namespaces', () => {
  const number = { type: 'math_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number' };
  const owner = { type: 'namespace_owner', message0: '%1 %2', args0: [
    { type: 'field_number', name: 'AMOUNT', value: 1 }, { type: 'input_value', name: 'AMOUNT' },
  ], previousStatement: null, nextStatement: null };
  const shapes = new Map([number, owner].map(json => [json.type, compileAbsDeclarativeContract(json)!]));
  const options = { argumentOrder: (type: string) => shapes.get(type)?.argumentOrder,
    fieldDefinition: (type: string, name: string) => shapes.get(type)?.fields[name], blockContract: (type: string) => shapes.get(type) };
  const source = (code: string) => '# ABS Schema: 2\n' + code;

  for (const call of ['namespace_owner(2, math_number(9))', 'namespace_owner(AMOUNT=2, AMOUNT=math_number(9))',
    'namespace_owner(AMOUNT=2)\n    @AMOUNT: 9']) it('binds both namespaces: ' + call, () => {
    const node = parseAbsSyntax(source(call), options)[0];
    expect(node.fields['AMOUNT'].value).toBe(2);
    expect(node.inputs['AMOUNT']!.fields['NUM'].value).toBe(9);
  });

  it('still rejects duplicate fields and duplicate inputs', () => {
    for (const call of ['namespace_owner(AMOUNT=2, AMOUNT=3)',
      'namespace_owner(2, math_number(9), AMOUNT=math_number(8))',
      'namespace_owner(2, math_number(9))\n    @AMOUNT: 8']) {
      expect(() => parseAbsSyntax(source(call), options)).toThrowError(/Duplicate/);
    }
    expect(compileAbsDeclarativeContract({ ...owner, args0: [owner.args0[0], owner.args0[0]] })).toBeUndefined();
    expect(compileAbsDeclarativeContract({ ...owner, args0: [owner.args0[1], { type: 'input_statement', name: 'AMOUNT' }] })).toBeUndefined();
  });

  it('addresses same-name statement sections without treating the field as a body', () => {
    const order = [{ name: 'BODY', kind: 'field' as const }, { name: 'BODY', kind: 'statementInput' as const }];
    const node = parseAbsSyntax(source('owner("label")\n    @BODY:\n        child()'), { argumentOrder: type => type === 'owner' ? order : [] })[0];
    expect(node.fields['BODY'].value).toBe('label'); expect(node.inputs['BODY']!.type).toBe('child');
  });

  it('preserves an old same-name connected child and identities through export/edit/import', async () => {
    const workspace = { blocks: { blocks: [{ id: 'owner', type: owner.type, deletable: false, fields: { AMOUNT: 2 },
      inputs: { AMOUNT: { block: { id: 'child', type: number.type, fields: { NUM: 9 } } } } }] } };
    const contracts = { fields: { owner: shapes.get(owner.type)!.fields, child: shapes.get(number.type)!.fields },
      syntax: { owner: shapes.get(owner.type)!.argumentOrder!, child: shapes.get(number.type)!.argumentOrder! } };
    const base = await createAbsProjection(workspace, { document: workspace, contracts, generation: 'g', baselineRef: 'r', savedAbiHash: null,
      scope: { projectKey: 'p', pageId: 'main' } });
    expect(base.abs).toContain('namespace_owner(2, math_number(9))');
    const edit = await reconcileAbsDraft(base, base.abs.replace('namespace_owner(2,', 'namespace_owner(3,'), options);
    expect(edit.workspace.blocks.blocks[0]).toEqual({ ...workspace.blocks.blocks[0], fields: { AMOUNT: 3 } });
    expect(edit.removed).toEqual([]); expect(edit.added).toEqual([]);
  });

  it('binds a native extension-created same-name socket without changing declared positions', async () => {
    const request: NativeCandidateRequest = { blocks: [], abs: source('namespace_owner(2, math_number(9))'), steps: [
      { kind: 'context', mode: 'arduino' },
      { kind: 'script', label: 'same-name-extension', source: `
        Blockly.Extensions.register('namespace_socket', function() { this.appendValueInput('AMOUNT').setCheck('Number'); });
        Arduino.forBlock.namespace_owner = block => String(block.getFieldValue('AMOUNT')) + ';\\n';
        Arduino.forBlock.math_number = block => [String(block.getFieldValue('NUM')), 0];
      ` },
      { kind: 'definitions', definitions: [number, { ...owner, message0: '%1', args0: [owner.args0[0]], extensions: ['namespace_socket'] }] },
    ] };
    const run = (input: NativeCandidateRequest) => evaluateNativeCandidate(input, { assertCurrent() {} });
    const result = await run(request), contracts: AbsProjectionContracts = { fields: {}, syntax: {} };
    for (const instance of result.binding!.instances) {
      contracts.fields[instance.id] = instance.shape.fields; contracts.syntax![instance.id] = instance.shape.argumentOrder!;
    }
    const state = normalizeAbsSerializedWorkspace(result.state);
    expect(state.blocks.blocks[0].fields!['AMOUNT']).toBe(2);
    expect(state.blocks.blocks[0].inputs!['AMOUNT'].block!.fields!['NUM']).toBe(9);
    const verified = await run({ steps: request.steps, blocks: [], verify: { state, contracts } });
    expect(normalizeAbsSerializedWorkspace(verified.state)).toEqual(state);
  });
});
