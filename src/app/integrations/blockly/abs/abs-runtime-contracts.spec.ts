import * as Blockly from 'blockly';
import { serializeRuntimeFieldContract } from '../../../editors/blockly-editor/services/blockly-runtime-block-metadata';
import { captureAbsRuntimeContracts } from './abs-runtime-contracts';
import { assertAbsRequestedState } from './abs-requested-state';
import { AbsAbiWorkspace } from './abs-state';
import { readAbsFieldToken, resolveAbsFieldValue } from './abs-field-values';
import { createAbsProjection } from './abs-identity-map';
import { reconcileAbs } from './abs-reconciler';

describe('ABS instance-bound runtime field contracts and readback', () => {
  let workspace: Blockly.Workspace;
  const save = () => Blockly.serialization.workspaces.save(workspace) as AbsAbiWorkspace;
  beforeEach(() => {
    workspace = new Blockly.Workspace();
    Blockly.Blocks['abs_dynamic_contract'] = {
      init() {
        this.appendDummyInput().appendField(new Blockly.FieldDropdown([['A', 'A'], ['B', 'B']]), 'FAMILY');
        const block = this;
        this.appendDummyInput().appendField(new Blockly.FieldDropdown(() => block.getFieldValue('FAMILY') === 'B'
          ? [['B mode', 'b']] : [['A mode', 'a']]), 'MODE');
        this.appendDummyInput().appendField(new Blockly.FieldNumber(1, 0, 10, 0.5), 'NUM');
        this.appendDummyInput().appendField(new Blockly.FieldCheckbox('FALSE'), 'CHECK');
      },
    };
  });
  afterEach(() => { workspace.dispose(); delete Blockly.Blocks['abs_dynamic_contract']; });

  it('captures different options for two instances of the same block type', () => {
    const a = workspace.newBlock('abs_dynamic_contract', 'a');
    const b = workspace.newBlock('abs_dynamic_contract', 'b');
    b.setFieldValue('B', 'FAMILY');
    const state = save();
    const runtime = captureAbsRuntimeContracts(workspace, state, () => undefined);
    expect(runtime.fieldDefinition(a.type, 'MODE', a.id)?.options).toEqual([['A mode', 'a']]);
    expect(runtime.fieldDefinition(b.type, 'MODE', b.id)?.options).toEqual([['B mode', 'b']]);
    expect(runtime.fieldDefinition(a.type, 'MODE')).toBeUndefined();
  });

  it('rejects a captured contract after the host runtime/session changes', () => {
    const block = workspace.newBlock('abs_dynamic_contract');
    let current = true;
    const runtime = captureAbsRuntimeContracts(workspace, save(), () => { if (!current) throw new Error('stale runtime'); });
    current = false;
    expect(() => runtime.fieldDefinition(block.type, 'NUM', block.id)).toThrowError('stale runtime');
  });

  it('retains actual numeric bounds and does not round/clamp silently', () => {
    const block = workspace.newBlock('abs_dynamic_contract');
    const runtime = captureAbsRuntimeContracts(workspace, save(), () => undefined);
    const definition = runtime.fieldDefinition(block.type, 'NUM', block.id);
    expect(definition).toEqual({ type: 'field_number', min: 0, max: 10, precision: 0.5 });
    expect(() => resolveAbsFieldValue(readAbsFieldToken('0.25'), definition)).toThrow();
    expect(() => resolveAbsFieldValue(readAbsFieldToken('11'), definition)).toThrow();
  });

  it('does not treat an unfamiliar field serializer as text', () => {
    class StructuredText extends Blockly.FieldTextInput {
      override saveState() { return { payload: [1, false] }; }
    }
    expect(serializeRuntimeFieldContract(new StructuredText('x'), { payload: [1, false] })).toEqual({ type: 'field_custom', valueType: 'json' });
  });

  it('reports option-provider errors instead of treating an empty fallback as a valid contract', () => {
    const block = workspace.newBlock('abs_dynamic_contract');
    const state = save();
    spyOn(block.getField('MODE') as Blockly.FieldDropdown, 'getOptions').and.throwError('library provider failed');
    expect(() => captureAbsRuntimeContracts(workspace, state, () => undefined))
      .toThrowMatching(error => error.code === 'ABS_FIELD_CONTRACT_UNAVAILABLE');
  });

  it('accepts native checkbox boolean serialization without changing string dropdowns', () => {
    const block = workspace.newBlock('abs_dynamic_contract');
    const expected = save();
    expected.blocks.blocks[0].fields!['CHECK'] = 'FALSE';
    const actual = save();
    const runtime = captureAbsRuntimeContracts(workspace, actual, () => undefined);
    expect(actual.blocks.blocks[0].fields!['CHECK']).toBeFalse();
    expect(() => assertAbsRequestedState(expected, actual, runtime.fieldDefinition)).not.toThrow();
    expected.blocks.blocks[0].fields!['MODE'] = false;
    expect(() => assertAbsRequestedState(expected, actual, runtime.fieldDefinition)).toThrow();
  });

  it('preserves real serialized fields through formatting edits and canonically stores changed checkboxes', async () => {
    workspace.newBlock('abs_dynamic_contract', 'a');
    const original = save();
    let current = original;
    const runtime = captureAbsRuntimeContracts(workspace, current, () => undefined);
    for (let round = 0; round < 3; round++) {
      const baseline = await createAbsProjection(current, { document: current, contracts: runtime.contracts,
        generation: 'g', baselineRef: 'r', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
      current = (await reconcileAbs(baseline, baseline.abs + '\n# comment')).workspace;
      expect(current).toEqual(original);
      const edited = await reconcileAbs(baseline, baseline.abs.replace('CHECK=false', 'CHECK=true'));
      Blockly.serialization.workspaces.load(edited.workspace, workspace);
      expect(edited.workspace.blocks.blocks[0].fields!['CHECK']).toBeTrue();
      expect(() => assertAbsRequestedState(edited.workspace, save(), runtime.fieldDefinition)).not.toThrow();
    }
  });

  it('detects a real dynamic dropdown silently keeping its default on load', () => {
    const expected: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'abs_dynamic_contract', id: 'a', fields: { FAMILY: 'A', MODE: 'not-an-option' } }] } };
    Blockly.serialization.workspaces.load(expected, workspace);
    const actual = save();
    expect(actual.blocks.blocks[0].fields!['MODE']).toBe('a');
    const runtime = captureAbsRuntimeContracts(workspace, actual, () => undefined);
    expect(() => assertAbsRequestedState(expected, actual, runtime.fieldDefinition)).toThrowMatching(error => error.code === 'ABS_READBACK_MISMATCH');
  });

  it('accepts dependent fields when the final loaded state matches the request', () => {
    const expected: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'abs_dynamic_contract', id: 'a', fields: { FAMILY: 'B', MODE: 'b' } }] } };
    Blockly.serialization.workspaces.load(expected, workspace);
    const actual = save();
    const runtime = captureAbsRuntimeContracts(workspace, actual, () => undefined);
    expect(() => assertAbsRequestedState(expected, actual, runtime.fieldDefinition)).not.toThrow();
  });

  it('does not require absent default fields, but rejects requested fields and extraState being dropped', () => {
    workspace.newBlock('abs_dynamic_contract', 'a');
    const actual = save();
    const runtime = captureAbsRuntimeContracts(workspace, actual, () => undefined);
    const expected: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'abs_dynamic_contract', id: 'a' }] } };
    expect(() => assertAbsRequestedState(expected, actual, runtime.fieldDefinition)).not.toThrow();
    expected.blocks.blocks[0].extraState = { requested: true };
    expect(() => assertAbsRequestedState(expected, actual, runtime.fieldDefinition)).toThrow();
    delete expected.blocks.blocks[0].extraState;
    expected.blocks.blocks[0].fields = { missingField: { payload: [1, false] } };
    expect(() => assertAbsRequestedState(expected, actual, runtime.fieldDefinition)).toThrow();
  });

  it('checks full FieldVariable name/type against the loaded model, even without a requested table', () => {
    Blockly.Blocks['abs_model_readback'] = { init() { this.appendDummyInput().appendField(new Blockly.FieldVariable('Count'), 'ANY_FIELD'); } };
    try {
      const block = workspace.newBlock('abs_model_readback', 'v');
      const actual = save();
      const runtime = captureAbsRuntimeContracts(workspace, actual, () => undefined);
      const expected = save();
      expected.blocks.blocks[0].fields!['ANY_FIELD'] = block.getField('ANY_FIELD')!.saveState(true);
      delete expected['variables'];
      expect(() => assertAbsRequestedState(expected, actual, runtime.fieldDefinition)).not.toThrow();
      (expected.blocks.blocks[0].fields!['ANY_FIELD'] as any).name = 'lost name';
      expect(() => assertAbsRequestedState(expected, actual, runtime.fieldDefinition)).toThrow();
    } finally { delete Blockly.Blocks['abs_model_readback']; }
  });

  it('checks fallback shadow state alongside its connected real block', () => {
    Blockly.Blocks['abs_shadow_parent'] = { init() { this.appendValueInput('VALUE'); } };
    Blockly.Blocks['abs_shadow_value'] = { init() { this.setOutput(true); this.appendDummyInput().appendField(new Blockly.FieldNumber(0), 'NUMBER'); } };
    try {
      const expected: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'abs_shadow_parent', id: 'parent', inputs: {
        VALUE: { block: { type: 'abs_shadow_value', id: 'value', fields: { NUMBER: 2 } },
          shadow: { type: 'abs_shadow_value', id: 'shadow', fields: { NUMBER: 1 } } },
      } }] } };
      Blockly.serialization.workspaces.load(expected, workspace);
      const actual = save();
      const runtime = captureAbsRuntimeContracts(workspace, actual, () => undefined);
      expect(() => assertAbsRequestedState(expected, actual, runtime.fieldDefinition)).not.toThrow();
      actual.blocks.blocks[0].inputs!['VALUE'].shadow!.fields!['NUMBER'] = 999;
      expect(() => assertAbsRequestedState(expected, actual, runtime.fieldDefinition)).toThrow();
    } finally { delete Blockly.Blocks['abs_shadow_parent']; delete Blockly.Blocks['abs_shadow_value']; }
  });
});
