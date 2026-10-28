import { decodeAbsState, splitAbsState } from './abs-full-state';
import * as Blockly from 'blockly';
import { blocks as builtinBlocks } from 'blockly/blocks';
import { getAbsProcedureReferences, AbsProcedureStateContract } from './abs-procedures';
import { captureAbsProcedureContracts } from './abs-runtime-procedures';
import { createAbsProjection, validateAbsProjection } from './abs-identity-map';
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
    const result = await reconcileAbs(baseline, splitAbsState(baseline.abs).program.replaceAll('"work"', '"renamed"'));
    expect(result.workspace.blocks.blocks.map(block => block.id)).toEqual(['d', 'c']);
    expect((result.workspace.blocks.blocks[0].extraState as any).arguments[0].argId).toBe('opaque');
  });
  it('does not interpret ordinary extraState objects as procedure signatures', () => {
    const state = workspace(); delete state['variables'];
    expect(getAbsProcedureReferences(state)).toEqual([]);
  });
  it('preserves a disabled orphan call and unknown parameter JSON without fabricating a model', async () => {
    const state = workspace(); state.blocks.blocks.shift(); state['variables'] = [];
    state.blocks.blocks[0]['disabledReasons'] = ['MANUALLY_DISABLED', 'LIBRARY_REASON'];
    state.blocks.blocks[0].extraState = { target: 'missing definition', arguments: [{ opaque: [null, false, 7] }], custom: { keep: true } };
    const before = JSON.stringify(state);
    expect(getAbsProcedureReferences(state, contracts)).toEqual([]);
    const baseline = await project(state);
    expect((await decodeAbsState(baseline.abs)).workspace).toEqual(state);
    await validateAbsProjection(baseline);
    expect(JSON.stringify(state)).toBe(before);
  });
  it('requires every active call to have an active definition even when a disabled definition matches', () => {
    const state = workspace(); state.blocks.blocks[0]['disabledReasons'] = ['MANUALLY_DISABLED'];
    expect(() => getAbsProcedureReferences(state, contracts)).toThrowMatching(error => error.code === 'ABS_PROCEDURE_INVALID');
    state.blocks.blocks[1]['disabledReasons'] = ['MANUALLY_DISABLED'];
    expect(() => getAbsProcedureReferences(state, contracts)).not.toThrow();
  });
  it('retains legacy identity references for valid inactive signatures and immutable-map reconstruction', async () => {
    const state = workspace(), previous = getAbsProcedureReferences(state, contracts);
    for (const block of state.blocks.blocks) block['disabledReasons'] = ['MANUALLY_DISABLED'];
    expect(getAbsProcedureReferences(state, contracts)).toEqual(previous);
    const baseline = await project(state);
    expect(baseline.map.symbols).toContain(jasmine.objectContaining({ kind: 'procedure', modelId: 'd', astPath: '/blocks/1/extraState/target' }));
    await validateAbsProjection(baseline);
  });
  it('does not make inactive stale/duplicate signatures constrain active definitions and calls', () => {
    const state = workspace();
    state.blocks.blocks.push({ type: 'custom_define', id: 'old', disabledReasons: ['MANUALLY_DISABLED'],
      fields: { TITLE: 'work' }, extraState: { arguments: [{ label: 'stale', variable: 'removed-id' }] } });
    const refs = getAbsProcedureReferences(state, { ...contracts, old: definition });
    expect(refs).toContain(jasmine.objectContaining({ blockId: 'c', kind: 'procedure', modelId: 'd' }));
    expect(refs.some(reference => reference.blockId === 'old')).toBeFalse();
  });
  it('distinguishes a disabled surrounding input from an active next call and covered shadow definition', () => {
    const orphan = workspace().blocks.blocks[1];
    const parent: any = { type: 'container', id: 'container', disabledReasons: ['MANUALLY_DISABLED'], inputs: { DO: { block: orphan } } };
    expect(getAbsProcedureReferences({ blocks: { blocks: [parent] } }, contracts)).toEqual([]);
    delete parent.inputs; parent.next = { block: orphan };
    expect(() => getAbsProcedureReferences({ blocks: { blocks: [parent] } }, contracts)).toThrowMatching(error => error.code === 'ABS_PROCEDURE_INVALID');
    const state = workspace(), dormant = state.blocks.blocks.shift()!;
    state.blocks.blocks.push({ type: 'owner', id: 'owner', inputs: { VALUE: { block: { type: 'value', id: 'value' }, shadow: dormant } } });
    expect(() => getAbsProcedureReferences(state, contracts)).toThrowMatching(error => error.code === 'ABS_PROCEDURE_INVALID');
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
  it('never reads inactive procedure capability getters and preserves their serialized state', async () => {
    const ws = new Blockly.Workspace(), type = 'abs_inactive_procedure';
    Blockly.Blocks[type] = { init() { this.appendDummyInput().appendField(new Blockly.FieldTextInput('unknown'), 'NAME'); },
      saveExtraState() { return { name: 'orphan', params: [{ unknown: [1, false] }], opaque: 'retained' }; } };
    try {
      const block = ws.newBlock(type, 'inactive');
      block.setDisabledReason(true, 'MANUALLY_DISABLED');
      const getter = jasmine.createSpy('inactive procedure capability').and.throwError('must not invoke');
      for (const key of ['getProcedureModel', 'getProcedureDef', 'getProcedureCall']) Object.defineProperty(block, key, { get: getter, configurable: true });
      const state = Blockly.serialization.workspaces.save(ws) as AbsAbiWorkspace;
      const captured = captureAbsProcedureContracts(ws, state, () => undefined);
      expect(captured).toEqual({}); expect(getter).not.toHaveBeenCalled();
      const baseline = await createAbsProjection(state, { document: state, contracts: { fields: {}, procedures: captured },
        generation: 'g', baselineRef: 'r', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
      expect((await decodeAbsState(baseline.abs)).workspace).toEqual(state);
      block.setDisabledReason(false, 'MANUALLY_DISABLED');
      expect(() => captureAbsProcedureContracts(ws, Blockly.serialization.workspaces.save(ws) as AbsAbiWorkspace, () => undefined)).toThrowError('must not invoke');
    } finally { ws.dispose(); delete Blockly.Blocks[type]; }
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
