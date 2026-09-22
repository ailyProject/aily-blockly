import * as Blockly from 'blockly';
import { createAbsProjection, validateAbsProjection } from './abs-identity-map';
import { reconcileAbs } from './abs-reconciler';
import { captureAbsRuntimeContracts } from './abs-runtime-contracts';
import { AbsAbiWorkspace, AbsProjectionContracts } from './abs-state';

describe('ABS model identity and readable reference projection', () => {
  const variable = { type: 'field_variable', symbol: { kind: 'variable' as const, storage: 'variable-state' as const } };
  const workspace = (): AbsAbiWorkspace => ({
    variables: [{ id: 'v1', name: '计数 😀', type: '' }, { id: 'v2', name: 'next', type: '' }, { id: 'unused', name: 'unused', type: '' }],
    blocks: { blocks: [{ type: 'get_value', id: 'b', deletable: false, fields: { BINDING: { id: 'v1' }, TEXT: 'keep' } }] },
  });
  const contracts = (): AbsProjectionContracts => ({ fields: { b: { BINDING: { ...variable, symbol: { ...variable.symbol } } } } });
  const project = (abi = workspace(), schema = contracts(), document: unknown = abi) => createAbsProjection(abi, {
    document, contracts: schema, generation: 'g1', baselineRef: 'r', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' },
  });

  it('keeps symbol IDs out of ABS and maps the field reference without copying model state', async () => {
    const baseline = await project();
    expect(baseline.abs).toContain('BINDING=$"计数 😀"');
    expect(baseline.abs).not.toContain('v1');
    expect(baseline.map.symbols).toEqual([{ nodeKey: 'n0', astPath: '/blocks/0/fields/BINDING', kind: 'variable', modelId: 'v1' }]);
    const result = await reconcileAbs(baseline, baseline.abs.replace('TEXT="keep"', 'TEXT="edited"'));
    expect(result.workspace.blocks.blocks[0].fields!['BINDING']).toEqual({ id: 'v1' });
    expect(result.workspace['variables']).toEqual(baseline.workspace['variables']);
  });

  it('retargets an existing variable and preserves full serialized state members', async () => {
    const abi = workspace();
    abi.blocks.blocks[0].fields!['BINDING'] = { id: 'v1', name: '计数 😀', type: '', custom: [1, 2] };
    const baseline = await project(abi);
    const result = await reconcileAbs(baseline, baseline.abs.replace('BINDING=$"计数 😀"', 'BINDING=$next'));
    expect(result.workspace.blocks.blocks[0].fields!['BINDING']).toEqual({ id: 'v2', name: 'next', type: '', custom: [1, 2] });
    expect(result.workspace.blocks.blocks[0]['deletable']).toBeFalse();
  });

  it('does not guess that an ordinary object with id/name is a variable', async () => {
    const abi = workspace();
    abi.blocks.blocks[0].fields!['DATA'] = { id: 'v1', name: 'payload' };
    const baseline = await project(abi);
    expect(baseline.abs).toContain('DATA={"id":"v1","name":"payload"}');
    expect(baseline.map.symbols.length).toBe(1);
  });

  it('does not create unknown models from a misspelled reference', async () => {
    const baseline = await project();
    await expectAsync(reconcileAbs(baseline, baseline.abs.replace('BINDING=$"计数 😀"', 'BINDING=$missing')))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_MISSING' }));
  });

  it('retains unchanged ambiguous display names, but refuses changed ambiguous references', async () => {
    const abi = workspace();
    abi['variables'] = [{ id: 'v1', name: 'same', type: 'int' }, { id: 'v2', name: 'same', type: 'text' }, { id: 'v3', name: 'other', type: '' }];
    const baseline = await project(abi);
    expect((await reconcileAbs(baseline, baseline.abs + '\n# comment')).workspace).toEqual(abi);
    abi.blocks.blocks[0].fields!['BINDING'] = { id: 'v3' };
    const other = await project(abi);
    await expectAsync(reconcileAbs(other, other.abs.replace('BINDING=$other', 'BINDING=$same')))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_AMBIGUOUS' }));
  });

  it('uses model type constraints instead of names to disambiguate variables', async () => {
    const abi = workspace();
    abi['variables'] = [{ id: 'v1', name: 'old', type: 'int' }, { id: 'v2', name: 'same', type: 'text' }, { id: 'v3', name: 'same', type: 'int' }];
    const schema = contracts();
    schema.fields['b']['BINDING'].symbol = { ...variable.symbol, allowedTypes: ['int'] };
    const baseline = await project(abi, schema);
    expect((await reconcileAbs(baseline, baseline.abs.replace('BINDING=$old', 'BINDING=$same'))).workspace.blocks.blocks[0].fields!['BINDING']).toEqual({ id: 'v3' });
  });

  it('uses the same lookup for host-declared procedure tables without adding full inline metadata', async () => {
    const abi: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'custom_call', id: 'c', fields: { TARGET: 'proc-1' } }] } };
    const document = { pages: [abi], shared: { procedures: [{ uuid: 'proc-1', label: 'render' }, { uuid: 'proc-2', label: 'clear' }] } };
    const schema: AbsProjectionContracts = {
      fields: { c: { TARGET: { type: 'field_custom', symbol: { kind: 'procedure', storage: 'id' } } } },
      symbolTables: [{ kind: 'procedure', source: 'document', path: '/shared/procedures', idPath: '/uuid', namePath: '/label' }],
    };
    const baseline = await project(abi, schema, document);
    expect(baseline.abs).toContain('TARGET="render"');
    expect(baseline.map.symbols[0].modelId).toBe('proc-1');
    expect((await reconcileAbs(baseline, baseline.abs.replace('"render"', '"clear"'))).workspace.blocks.blocks[0].fields!['TARGET']).toBe('proc-2');
    expect(baseline.document).toEqual(document);
  });

  it('binds new blocks through explicit definitions, without deleting unused model rows', async () => {
    const baseline = await project();
    const edited = baseline.abs + '\nnew_get(BINDING="next")';
    const result = await reconcileAbs(baseline, edited, { newId: () => 'new-id', fieldDefinition: (type) => type === 'new_get' ? variable : undefined });
    expect(result.workspace.blocks.blocks[1].fields!['BINDING']).toEqual({ id: 'v2' });
    expect(result.workspace['variables']).toEqual(workspace()['variables']);
  });

  it('rejects forged symbol bindings and changed projection contracts', async () => {
    const baseline = await project();
    baseline.map.symbols[0].modelId = 'v2';
    await expectAsync(validateAbsProjection(baseline)).toBeRejected();
    const other = await project();
    other.contracts.fields['b']['BINDING'] = { type: 'field_custom' };
    await expectAsync(validateAbsProjection(other)).toBeRejected();
  });

  it('rejects dangling model IDs and duplicate model identities', async () => {
    const abi = workspace();
    abi.blocks.blocks[0].fields!['BINDING'] = { id: 'missing' };
    await expectAsync(project(abi)).toBeRejected();
    abi['variables'] = [{ id: 'same-id', name: 'a' }, { id: 'same-id', name: 'b' }];
    await expectAsync(project(abi)).toBeRejected();
  });

  it('round trips real FieldVariable instances using arbitrary field names', async () => {
    const ws = new Blockly.Workspace();
    Blockly.Blocks['abs_var_runtime'] = { init() { this.appendDummyInput().appendField(new Blockly.FieldVariable('Counter'), 'ANY_NAME'); } };
    try {
      const block = ws.newBlock('abs_var_runtime');
      const state = Blockly.serialization.workspaces.save(ws) as AbsAbiWorkspace;
      const captured = captureAbsRuntimeContracts(ws, state, () => undefined);
      let current = state;
      for (let round = 0; round < 3; round++) {
        const baseline = await project(current, captured.contracts);
        expect(baseline.abs).toContain('ANY_NAME=$Counter');
        current = (await reconcileAbs(baseline, baseline.abs + '\n# formatting only')).workspace;
        expect(current.blocks.blocks[0].id).toBe(block.id);
      }
      expect(current).toEqual(state);
    } finally { ws.dispose(); delete Blockly.Blocks['abs_var_runtime']; }
  });
});
