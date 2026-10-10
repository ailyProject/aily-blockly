import * as Blockly from 'blockly';
import './blockly-legacy-library-compat';

describe('v11 published library compatibility on Blockly v13', () => {
  let workspace: Blockly.Workspace;
  beforeEach(() => {
    workspace = new Blockly.Workspace();
    Blockly.Blocks['legacy_variable_probe'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldVariable('item'), 'VAR');
    } };
  });
  afterEach(() => {
    workspace.dispose();
    delete Blockly.Blocks['legacy_variable_probe'];
  });

  it('shares the v13 variable map and preserves ids, names, types and legacy property access', () => {
    const legacy = workspace as any;
    const variable = legacy.createVariable('温度', 'Number', 'stable-id');
    expect(variable).toBe(workspace.getVariableMap().getVariableById('stable-id'));
    expect(legacy.getVariable('温度', 'Number')).toBe(variable);
    expect(legacy.getVariablesOfType('Number')).toEqual([variable]);
    expect(legacy.getAllVariables()).toEqual([variable]);
    expect(legacy.getAllVariableNames()).toEqual(['温度']);
    expect(variable.name).toBe('温度');
    expect(variable.type).toBe('Number');
    legacy.renameVariableById('stable-id', '新温度');
    expect(variable.getName()).toBe('新温度');
    expect(variable.name).toBe('新温度');
    const saved = Blockly.serialization.workspaces.save(workspace);
    workspace.clear();
    Blockly.serialization.workspaces.load(saved, workspace);
    expect(legacy.getVariableById('stable-id').getName()).toBe('新温度');
    legacy.deleteVariableById('stable-id');
    expect(legacy.getVariableById('stable-id')).toBeNull();
  });

  it('keeps variable references and updates a field when the old rename entry point is used', () => {
    const legacy = workspace as any;
    legacy.createVariable('item', '', 'item-id');
    const block = workspace.newBlock('legacy_variable_probe');
    block.setFieldValue('item-id', 'VAR');
    expect((block as any).getVars()).toEqual(['item-id']);
    expect(legacy.getVariableUsesById('item-id')).toEqual([block]);
    legacy.renameVariableById('item-id', 'renamed');
    expect(block.getField('VAR')!.getText()).toBe('renamed');
    legacy.deleteVariableById('item-id');
    expect(workspace.getAllBlocks(false)).toEqual([]);
  });

  it('changes only the manual disabled reason and retains other disabling reasons', () => {
    const block = workspace.newBlock('legacy_variable_probe');
    (block as any).setEnabled(false);
    expect(block.isEnabled()).toBeFalse();
    block.setDisabledReason(true, 'orphan');
    (block as any).setEnabled(true);
    expect(block.isEnabled()).toBeFalse();
    block.setDisabledReason(false, 'orphan');
    expect(block.isEnabled()).toBeTrue();
    expect((Blockly.VariableModel as any).compareByName).toBe(Blockly.Variables.compareByName);
  });
});
