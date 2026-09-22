import * as Blockly from 'blockly';
import { convertAbiToAbs, convertAbsToAbi } from './abi-abs-converter';
import { queryLiveAbsBlockShape } from './abs-live-block-shape';
import { setGlobalBlockMetas } from './block-definition.service';

describe('ABS read-only live block structure', () => {
  let workspace: Blockly.Workspace;
  let previousBlockly: unknown;
  const type = 'abs_readonly_structure_test';
  beforeEach(() => {
    previousBlockly = window['Blockly'];
    workspace = new Blockly.Workspace();
    window['Blockly'] = { ...Blockly, getMainWorkspace: () => workspace };
    Blockly.Blocks[type] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldVariable('item'), 'VAR');
      this.appendValueInput('VALUE');
      this.appendStatementInput('BODY');
    } };
    setGlobalBlockMetas(new Map());
  });
  afterEach(() => {
    workspace.dispose();
    delete Blockly.Blocks[type];
    window['Blockly'] = previousBlockly;
    setGlobalBlockMetas(new Map());
  });

  it('exports and parses a JS-only block without creating probe blocks or variables', () => {
    const block = workspace.newBlock(type);
    const variable = workspace.getVariableMap().createVariable('item');
    block.setFieldValue(variable.getId(), 'VAR');
    const before = Blockly.serialization.workspaces.save(workspace);
    const newBlock = spyOn(workspace, 'newBlock').and.throwError('Projection must be read-only');
    const result = convertAbsToAbi(convertAbiToAbs(before));
    expect(result.success).toBeTrue();
    expect(result.abiJson.blocks.blocks[0].fields.VAR).toBeDefined();
    expect(Blockly.serialization.workspaces.save(workspace)).toEqual(before);
    expect(newBlock).not.toHaveBeenCalled();
  });

  it('selects the actual dynamic shape by ID and refuses an ambiguous type-only lookup', () => {
    const first = workspace.newBlock(type);
    const second = workspace.newBlock(type);
    second.appendStatementInput('ADDITIONAL');
    expect(queryLiveAbsBlockShape(type, first.id)!.statementInputNames).toEqual(['BODY']);
    expect(queryLiveAbsBlockShape(type, second.id)!.statementInputNames).toEqual(['BODY', 'ADDITIONAL']);
    expect(queryLiveAbsBlockShape(type)).toBeUndefined();
    expect(queryLiveAbsBlockShape(type, 'missing')).toBeUndefined();
  });

  it('accepts identical existing shapes without a type-global cache', () => {
    const first = workspace.newBlock(type);
    const second = workspace.newBlock(type);
    expect(queryLiveAbsBlockShape(type)!.valueInputNames).toEqual(['VALUE']);
    first.appendValueInput('NEXT');
    expect(queryLiveAbsBlockShape(type)).toBeUndefined();
    second.appendValueInput('NEXT');
    expect(queryLiveAbsBlockShape(type)!.valueInputNames).toEqual(['VALUE', 'NEXT']);
  });

  it('does not retain a previous workspace shape for the same block type', () => {
    workspace.newBlock(type).appendStatementInput('OLD');
    expect(queryLiveAbsBlockShape(type)!.statementInputNames).toContain('OLD');
    workspace.dispose();
    workspace = new Blockly.Workspace();
    expect(queryLiveAbsBlockShape(type)).toBeUndefined();
    workspace.newBlock(type).appendValueInput('NEW');
    expect(queryLiveAbsBlockShape(type)!.statementInputNames).toEqual(['BODY']);
    expect(queryLiveAbsBlockShape(type)!.valueInputNames).toContain('NEW');
  });

  it('never instantiates an absent JS definition while parsing an unknown block', () => {
    const newBlock = spyOn(workspace, 'newBlock').and.throwError('Do not initialize definitions');
    expect(queryLiveAbsBlockShape(type)).toBeUndefined();
    const result = convertAbsToAbi(`${type}("value")`);
    expect(result.success && !result.warnings?.length).toBeFalse();
    expect(newBlock).not.toHaveBeenCalled();
  });

  it('reads explicit variable constraints without invoking field getters', () => {
    const block = workspace.newBlock(type);
    const field: any = block.getField('VAR');
    field.variableTypes = ['FUNC'];
    spyOn(field, 'getVariable').and.throwError('Do not call model getters');
    spyOn(field, 'getVariableTypes').and.throwError('Do not query workspace variables');
    expect(queryLiveAbsBlockShape(type, block.id)!.fieldVariableTypes['VAR']).toBe('FUNC');
  });
});
