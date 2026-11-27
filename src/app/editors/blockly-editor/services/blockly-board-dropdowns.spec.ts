import * as Blockly from 'blockly';
import { BlocklyEditorComponent } from '../blockly-editor.component';
import { resolveBoardJsonBindings } from '../components/blockly/board-json-bindings';
import { BlocklyService } from './blockly.service';
import { restoreNativeFields } from './blockly-native-state-loading';
import { changedBoardKeys, forgetSavedBoardSelections, preserveLegacySerialChoices, recordBoardDropdowns,
  refreshLiveBoardDropdowns, rememberSavedBoardSelections } from './blockly-board-dropdowns';

describe('asynchronous cloud board fields', () => {
  const type = 'cloud_board_test_field';
  const raw = { type, message0: '%1 %2 %3', args0: [
    { type: 'field_dropdown', name: 'SERIAL', options: '${board.serialPort}' },
    { type: 'field_dropdown', name: 'PIN', options: '${board.digitalPins}' },
    { type: 'field_dropdown', name: 'MODE', options: [['On', 'on']] },
  ] };
  const local = { serialPort: [['HW UART', 'Serial'], ['UART 1', 'Serial1']], digitalPins: [['Pin A', 'PA']] };
  let ws: Blockly.Workspace;
  const register = board => {
    Blockly.defineBlocksWithJsonArray([resolveBoardJsonBindings(raw, board)]);
    recordBoardDropdowns(Blockly.Blocks[type], raw);
  };
  const open = () => {
    const fields = { SERIAL: 'Serial0', PIN: 'PB7', MODE: 'on' };
    rememberSavedBoardSelections(ws, { blocks: { blocks: [{ type, id: 'saved', fields }] } });
    const block = ws.newBlock(type, 'saved');
    restoreNativeFields(block, fields);
    return block;
  };
  beforeEach(() => { ws = new Blockly.Workspace(); register(local); });
  afterEach(() => { ws.dispose(); delete Blockly.Blocks[type]; });

  it('restores only the admitted board field on the admitted block and workspace', () => {
    const block = open();
    expect(block.getFieldValue('SERIAL')).toBe('Serial0');
    expect(block.getFieldValue('PIN')).toBe('PB7');
    expect(() => restoreNativeFields(block, { PIN: 'other' })).toThrow();
    expect(() => restoreNativeFields(block, { MODE: 'PB7' })).toThrow();
    expect(() => restoreNativeFields(ws.newBlock(type, 'other'), { PIN: 'PB7' })).toThrow();
    const other = new Blockly.Workspace();
    try { expect(() => restoreNativeFields(other.newBlock(type, 'saved'), { SERIAL: 'Serial0' })).toThrow(); }
    finally { other.dispose(); }
  });

  it('refreshes live options after an edit, preserving serialization, undo, validators and later option providers', async () => {
    const block = open();
    const serial = block.getField('SERIAL') as Blockly.FieldDropdown;
    const pin = block.getField('PIN') as Blockly.FieldDropdown;
    let extras = [['Custom', 'custom']];
    serial.setOptions(() => [...local.serialPort, ...extras] as [string, string][]);
    serial.setValue('Serial1');
    const board = { serialPort: [['Updated UART 1', 'Serial1'], ['USB', 'Serial0']], digitalPins: [['Pin C', 'PC']] };
    await new Promise(resolve => setTimeout(resolve, 15));
    const before = Blockly.serialization.workspaces.save(ws);
    const undo = ws.getUndoStack().slice();
    const validator = jasmine.createSpy('validator');
    serial.setValidator(validator);
    pin.setValidator(validator);
    const edit = jasmine.createSpy('edit');
    ws.addChangeListener(event => { if (!event.isUiEvent) edit(event.type); });
    register(board);
    refreshLiveBoardDropdowns(ws, local, board, changedBoardKeys(local, board));
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(Blockly.serialization.workspaces.save(ws)).toEqual(before);
    expect(ws.getUndoStack()).toEqual(undo);
    expect(validator).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(serial.getText()).toBe('Updated UART 1');
    expect(pin.getOptions(false)).toContain(['PB7', 'PB7']);
    expect(serial.getOptions(false)).toContain(['Custom', 'custom']);
    extras = [['Second custom', 'second']];
    expect(serial.getOptions(false)).not.toContain(['Custom', 'custom']);
    expect(serial.getOptions(false)).toContain(['Second custom', 'second']);
    expect((ws.newBlock(type).getField('PIN') as Blockly.FieldDropdown).getOptions(false)).toEqual([['Pin C', 'PC']]);
    forgetSavedBoardSelections(ws);
    serial.setOptions([['Later board', 'later']]);
    expect(serial.getOptions(false)).toEqual([['Later board', 'later']]);
  });

  it('keeps legacy UI choices only while selected and migrates Serial0 on explicit CDC disable', async () => {
    const block = open();
    const realm = { generateSerialPortOptionsWithCustom: () => local.serialPort };
    preserveLegacySerialChoices(realm, () => ws);
    expect(realm.generateSerialPortOptionsWithCustom()).toContain(['Serial0', 'Serial0']);
    block.setFieldValue('Serial', 'SERIAL');
    expect(realm.generateSerialPortOptionsWithCustom()).not.toContain(['Serial0', 'Serial0']);
    block.setFieldValue('Serial0', 'SERIAL');
    const service = Object.assign(Object.create(BlocklyService.prototype), { _workspace: ws, boardConfig: local,
      refreshBoardDependentBlockDefinitions: jasmine.createSpy('refresh'), syncSerialDynamicToolboxBlocks: jasmine.createSpy('toolbox') });
    const invokeGlobal = jasmine.createSpy('invoke');
    const component: any = Object.assign(Object.create(BlocklyEditorComponent.prototype), { blocklyService: service,
      generatorRuntime: { isActive: () => false, invokeGlobal } });
    const enabled = { ...local, _cdcEnabled: true, cdcSerialPort: [['USB', 'Serial']] };
    const original = window['boardConfig'];
    try {
      component.applyRuntimeBoardConfig(enabled, true);
      expect(block.getFieldValue('SERIAL')).toBe('Serial0');
      expect(invokeGlobal).not.toHaveBeenCalled();
      component.applyRuntimeBoardConfig({ ...enabled, _cdcEnabled: false });
      await new Promise(resolve => setTimeout(resolve, 180));
      expect(invokeGlobal).toHaveBeenCalledWith('updateSerialCustomPorts');
      expect(block.getFieldValue('SERIAL')).toBe('Serial');
      expect(realm.generateSerialPortOptionsWithCustom()).not.toContain(['Serial0', 'Serial0']);
    } finally { window['boardConfig'] = original; }
  });
});
