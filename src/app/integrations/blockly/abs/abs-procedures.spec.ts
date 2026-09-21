import * as Blockly from 'blockly';
import { blocks as builtinBlocks } from 'blockly/blocks';
import { getAbsProcedureReferences, AbsProcedureStateContract } from './abs-procedures';
import { captureAbsProcedureContracts } from './abs-runtime-procedures';
import { createAbsProjection } from './abs-identity-map';
import { reconcileAbs } from './abs-reconciler';
import { AbsAbiWorkspace } from './abs-state';
import { captureAbsRuntimeContracts } from './abs-runtime-contracts';
import { assertAbsReadback } from './abs-readback';

describe('ABS explicit procedure serialization contracts', () => {
  const definition: AbsProcedureStateContract = { role: 'definition', namePath: '/fields/TITLE', parametersPath: '/extraState/arguments',
    parameterNamePath: '/label', parameterVariableIdPath: '/variable', returns: false };
  const call: AbsProcedureStateContract = { role: 'call', namePath: '/extraState/target', parametersPath: '/extraState/arguments', parameterNamePath: '', returns: false };
  const contracts = { d: definition, c: call };
  const workspace = (): AbsAbiWorkspace => ({ variables: [{ id: 'v', name: 'arg', type: '' }], blocks: { blocks: [
    { type: 'custom_define', id: 'd', fields: { TITLE: 'work' }, extraState: { arguments: [{ label: 'arg', variable: 'v', argId: 'opaque' }], data: [1, false] } },
    { type: 'custom_call', id: 'c', extraState: { target: 'work', arguments: ['arg'] } },
  ] } });
  const project = (state = workspace()) => createAbsProjection(state, { document: state, generation: 'g', baselineRef: 'r',
    savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' }, contracts: { fields: {}, procedures: contracts } });

  it('binds calls to stable definition IDs and parameters to model IDs without duplicating state', async () => {
    const baseline = await project();
    expect(baseline.map.symbols).toContain(jasmine.objectContaining({ kind: 'procedure', modelId: 'd', astPath: '/blocks/1/extraState/target' }));
    expect(baseline.map.symbols).toContain(jasmine.objectContaining({ kind: 'variable', modelId: 'v' }));
    expect((await reconcileAbs(baseline, baseline.abs + '\n# formatting')).workspace).toEqual(workspace());
  });
  it('rejects deleting a referenced definition before any Blockly load', async () => {
    const baseline = await project();
    const edited = baseline.abs.split('\n').filter(line => !line.startsWith('custom_define(')).join('\n');
    await expectAsync(reconcileAbs(baseline, edited)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROCEDURE_INVALID' }));
  });
  it('rejects drift in call signatures, missing parameter models and duplicate definitions', () => {
    const state = workspace(); (state.blocks.blocks[1].extraState as any).arguments = ['typo'];
    expect(() => getAbsProcedureReferences(state, contracts)).toThrow();
    const missing = workspace(); missing['variables'] = [];
    expect(() => getAbsProcedureReferences(missing, contracts)).toThrow();
    const duplicate = workspace(); duplicate.blocks.blocks.push({ ...duplicate.blocks.blocks[0], id: 'd2' });
    expect(() => getAbsProcedureReferences(duplicate, { ...contracts, d2: definition })).toThrow();
  });
  it('permits an explicitly consistent rename, preserving IDs and unknown extraState members', async () => {
    const baseline = await project();
    const result = await reconcileAbs(baseline, baseline.abs.replaceAll('"work"', '"renamed"'));
    expect(result.workspace.blocks.blocks.map(block => block.id)).toEqual(['d', 'c']);
    expect((result.workspace.blocks.blocks[0].extraState as any).arguments[0].argId).toBe('opaque');
  });
  it('does not interpret ordinary extraState objects as procedure signatures', () => {
    const state = workspace(); delete state['variables'];
    expect(getAbsProcedureReferences(state)).toEqual([]);
  });
  it('refuses an unadapted model-backed runtime instead of guessing its JSON layout', () => {
    const ws = new Blockly.Workspace();
    Blockly.Blocks['abs_model_backed'] = { init() {}, getProcedureModel() { return {}; } };
    try {
      ws.newBlock('abs_model_backed');
      const state = Blockly.serialization.workspaces.save(ws) as AbsAbiWorkspace;
      expect(() => captureAbsProcedureContracts(ws, state, () => undefined))
        .toThrowMatching(error => error.code === 'ABS_PROCEDURE_CONTRACT_UNSUPPORTED');
    } finally { ws.dispose(); delete Blockly.Blocks['abs_model_backed']; }
  });
  it('round trips dynamic parameter field names and arbitrary input names without adding metadata syntax', async () => {
    const state = workspace();
    state.blocks.blocks[0].fields!['arg-id/😀'] = 'arg';
    state.blocks.blocks[0].inputs = { 'slot /😀': { block: { type: 'child', id: 'child', next: { block: { type: 'tail', id: 'tail' } } } } };
    const baseline = await project(state);
    expect(baseline.abs).toContain('"arg-id/😀"="arg"');
    expect(baseline.abs).toContain('@"slot /😀":');
    expect((await reconcileAbs(baseline, baseline.abs + '\n# comment')).workspace).toEqual(state);
  });
  it('captures native legacy procedures through capabilities, independent of block type spelling', async () => {
    const ws = new Blockly.Workspace();
    Blockly.Blocks['abs_native_definition'] = builtinBlocks['procedures_defnoreturn'];
    Blockly.Blocks['abs_native_call'] = builtinBlocks['procedures_callnoreturn'];
    Blockly.Events.disable();
    try {
      const state: AbsAbiWorkspace = { variables: [{ id: 'arg-v', name: 'arg', type: '' }], blocks: { blocks: [
        { type: 'abs_native_definition', id: 'd', fields: { NAME: 'work' }, extraState: { params: [{ name: 'arg', id: 'arg-v' }] } },
        { type: 'abs_native_call', id: 'c', extraState: { name: 'work', params: ['arg'] } },
      ] } };
      Blockly.serialization.workspaces.load(state, ws);
      let current = Blockly.serialization.workspaces.save(ws) as AbsAbiWorkspace;
      const captured = captureAbsProcedureContracts(ws, current, () => undefined);
      expect(captured['d'].role).toBe('definition'); expect(captured['c'].role).toBe('call');
      for (let i = 0; i < 3; i++) {
        const fields = captureAbsRuntimeContracts(ws, current, () => undefined);
        const baseline = await createAbsProjection(current, { document: current, contracts: { ...fields.contracts, procedures: captured },
          generation: 'g', baselineRef: 'r', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
        const result = await reconcileAbs(baseline, baseline.abs + '\n# comment');
        Blockly.serialization.workspaces.load(result.workspace, ws);
        current = Blockly.serialization.workspaces.save(ws) as AbsAbiWorkspace;
        expect(() => assertAbsReadback(result.workspace, current, fields)).not.toThrow();
      }
    } finally { ws.dispose(); Blockly.Events.enable(); delete Blockly.Blocks['abs_native_definition']; delete Blockly.Blocks['abs_native_call']; }
  });
});
