import * as Blockly from 'blockly';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { observeNativeBlockDefinition } from '../../../editors/blockly-editor/services/blockly-native-structure';
import { restoreNativeFields, withNativeStateLoading } from '../../../editors/blockly-editor/services/blockly-native-state-loading';
import { absJson } from './abs-json';

describe('native dynamic field loading without declaration JSON', () => {
  const type = 'native_field_loading_js', parentType = 'native_field_loading_parent';
  let workspace: Blockly.Workspace, catalog: BlocklyDeclarativeBlockCatalog;
  const blockState = (id = 'kept') => ({ type, id, fields: { A_TEXT: 'saved text', M_CHOICE: 'C', Z_MODE: 'B' }, deletable: false });
  const state = () => ({ blocks: { blocks: [blockState()] } });
  const load = (value: any) => BlocklyService.prototype.loadWorkspaceJson.call({
    workspace, iconsMap: new Map(), cloneJson: value => structuredClone(value), assertWorkspaceEditAvailable() {},
    captureDeclarativeBlockDefinitions: () => catalog.capture(Blockly.Blocks), scheduleWorkspaceRenderAfterLoad() {},
  } as any, value);
  beforeEach(() => {
    workspace = new Blockly.Workspace(); catalog = new BlocklyDeclarativeBlockCatalog();
    Blockly.Blocks[type] = { init() {
      this.appendDummyInput('mode').appendField(new Blockly.FieldDropdown([['A', 'A'], ['B', 'B']], mode => {
        if (this.getInput('choice')) this.removeInput('choice');
        if (this.getInput('text')) this.removeInput('text');
        if (mode === 'B') {
          this.appendDummyInput('choice').appendField(new Blockly.FieldDropdown([['A', 'A'], ['C', 'C']], choice => {
            if (this.getInput('text')) this.removeInput('text');
            if (choice === 'C') this.appendDummyInput('text').appendField(new Blockly.FieldTextInput('default'), 'A_TEXT');
            return choice;
          }), 'M_CHOICE');
          this.moveInputBefore('choice', 'mode');
        }
        return mode;
      }), 'Z_MODE');
      this.setOutput(true);
    } };
    observeNativeBlockDefinition(Blockly.Blocks[type]);
    Blockly.Blocks[parentType] = { init() { this.appendValueInput('VALUE'); } };
  });
  afterEach(() => { workspace.dispose(); delete Blockly.Blocks[type]; delete Blockly.Blocks[parentType]; });

  it('restores multiple selector levels in the ordinary load entry, then saves and reopens', () => {
    const input = state(), before = absJson(input);
    expect(catalog.capture(Blockly.Blocks).get(type)).toBeUndefined();
    for (let i = 0; i < 2; i++) {
      load(i ? JSON.parse(absJson(Blockly.serialization.workspaces.save(workspace))) : input);
      expect(workspace.getBlockById('kept')!.getFieldValue('A_TEXT')).toBe('saved text');
      expect(workspace.getBlockById('kept')!.isDeletable()).toBeFalse();
    }
    expect(absJson(input)).toBe(before);
  });

  it('keeps configurations of the same JS-only type instance-local and supports missing IDs', () => {
    const withoutId: any = blockState(); delete withoutId.id;
    const input = { blocks: { blocks: [withoutId, { type, id: 'other', fields: { Z_MODE: 'A' } }] } };
    load(input);
    expect(workspace.getAllBlocks(false).filter(block => block.getFieldValue('A_TEXT') === 'saved text').length).toBe(1);
    expect(workspace.getBlockById('other')!.getField('A_TEXT')).toBeNull();
    expect(withoutId.id).toBeUndefined();
  });

  it('restores nested blocks and shadow defaults before connections, including native shadow respawn', () => {
    load({ blocks: { blocks: [{ type: parentType, id: 'parent', inputs: { VALUE: {
      shadow: blockState('shadow'), block: blockState('real'),
    } } }] } });
    const parent = workspace.getBlockById('parent')!, real = workspace.getBlockById('real')!;
    expect(real.getFieldValue('A_TEXT')).toBe('saved text');
    const shadow = parent.getInput('VALUE')!.connection!.getShadowState()!;
    expect(shadow.fields!['A_TEXT']).toBe('saved text');
    real.dispose();
    expect(parent.getInputTargetBlock('VALUE')!.isShadow()).toBeTrue();
    expect(parent.getInputTargetBlock('VALUE')!.getFieldValue('A_TEXT')).toBe('saved text');
  });

  it('restores extraState first and keeps native parent-before-field semantics', () => {
    Blockly.Blocks[type] = { init() { this.setOutput(true); }, loadExtraState() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput('default', value => {
        expect(this.getParent()?.type).toBe(parentType); return value;
      }), 'TEXT');
    } };
    load({ blocks: { blocks: [{ type: parentType, id: 'parent', inputs: { VALUE: { block: {
      type, id: 'child', extraState: { enabled: true }, fields: { TEXT: 'kept' },
    } } } }] } });
    expect(workspace.getBlockById('child')!.getFieldValue('TEXT')).toBe('kept');
  });

  it('reloads a replaced field instance but never loads an unchanged instance twice', () => {
    const loads: string[] = [];
    Blockly.Blocks[type] = { init() {
      const detail = () => {
        if (this.getInput('detail')) this.removeInput('detail');
        const field = new Blockly.FieldTextInput('default');
        const original = field.loadState;
        field.loadState = value => { loads.push(value); original.call(field, value); };
        this.appendDummyInput('detail').appendField(field, 'A_TEXT');
      };
      detail();
      this.appendDummyInput('mode').appendField(new Blockly.FieldTextInput('A', value => { detail(); return value; }), 'Z_MODE');
    } };
    load({ blocks: { blocks: [{ type, id: 'kept', fields: { A_TEXT: 'kept', Z_MODE: 'B' } }] } });
    expect(loads).toEqual(['kept', 'kept']);
    expect(workspace.getBlockById('kept')!.getFieldValue('A_TEXT')).toBe('kept');
  });

  it('rejects missing fields and always restores the scoped method and detached data properties', () => {
    const input = state(); input.blocks.blocks[0].fields['UNKNOWN'] = 'data';
    const before = absJson(input), method = workspace.newBlock;
    expect(() => withNativeStateLoading(Blockly, workspace, input,
      () => Blockly.serialization.workspaces.load(input, workspace))).toThrowError(/Cannot restore native field.*UNKNOWN/);
    expect(workspace.newBlock).toBe(method);
    expect(Object.hasOwn(workspace, 'newBlock')).toBeFalse();
    expect(Object.getOwnPropertyDescriptor(input.blocks.blocks[0], 'fields')!.get).toBeUndefined();
    expect(absJson(input)).toBe(before);
    load(state());
    expect(workspace.getBlockById('kept')!.getFieldValue('A_TEXT')).toBe('saved text');
  });

  it('preserves native ID remapping and leaves other workspaces untouched', () => {
    const other = new Blockly.Workspace();
    try {
      const old = workspace.newBlock(type, 'kept'), input = blockState();
      const method = other.newBlock;
      const created = withNativeStateLoading(Blockly, workspace, input, () => {
        expect(other.newBlock).toBe(method);
        return Blockly.serialization.blocks.append(input, workspace);
      });
      expect(created.id).not.toBe(old.id);
      expect(created.getFieldValue('A_TEXT')).toBe('saved text');
      expect(old.getFieldValue('Z_MODE')).toBe('A');
    } finally { other.dispose(); }
  });

  it('rejects callbacks overwriting an already loaded field instead of replaying forever', () => {
    Blockly.Blocks[type] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput('default'), 'A');
      this.appendDummyInput().appendField(new Blockly.FieldTextInput('default', value => { this.setFieldValue('overwritten', 'A'); return value; }), 'B');
    } };
    const block = workspace.newBlock(type);
    expect(() => restoreNativeFields(block, { A: 'kept', B: 'changed' })).toThrowError(/changed during restoration/);
  });

  it('defers an existing dropdown until another field enables its requested option', () => {
    Blockly.Blocks[type] = { init() {
      let mode = 'A';
      this.appendDummyInput().appendField(new Blockly.FieldDropdown(() => mode === 'B' ? [['new', 'new']] : [['old', 'old']]), 'A_OPTION');
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([['A', 'A'], ['B', 'B']], value => { mode = value; return value; }), 'Z_MODE');
    } };
    load({ blocks: { blocks: [{ type, fields: { A_OPTION: 'new', Z_MODE: 'B' } }] } });
    expect(workspace.getAllBlocks(false)[0].getFieldValue('A_OPTION')).toBe('new');
  });

  it('does not silently replace an invalid dropdown value with the default', () => {
    const input = state(); input.blocks.blocks[0].fields.Z_MODE = 'invalid';
    expect(() => load(input)).toThrowError(/Cannot restore native field/);
  });

  it('retains the exact old U8G2 font symbol only on its matching picker', () => {
    Blockly.Blocks['u8g2_set_font'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([['14px', '14']]), 'SIZE');
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([['Chinese', 'CHINESE']]), 'FONT_TYPE');
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([['new font', 'u8g2_font_wqy14_t_chinese2']]), 'FONT');
    } };
    try {
      const block = workspace.newBlock('u8g2_set_font');
      restoreNativeFields(block, { SIZE: '14', FONT_TYPE: 'CHINESE', FONT: 'u8g2_font_wqy13_t_chinese2' });
      expect(block.getFieldValue('FONT')).toBe('u8g2_font_wqy13_t_chinese2');
      expect((block.getField('FONT') as Blockly.FieldDropdown).getOptions(false)
        .some(option => option[1] === 'u8g2_font_wqy13_t_chinese2')).toBeTrue();
      expect(() => restoreNativeFields(block, { FONT: 'unrelated-unknown-font' }))
        .toThrowError(/Cannot restore native field/);
    } finally { delete Blockly.Blocks['u8g2_set_font']; }
  });

  it('loads a saved custom SSCMA serial port without changing other dropdowns', () => {
    Blockly.Blocks['sscma_begin_serial'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([['Serial', 'Serial']]), 'SERIAL');
    } };
    try {
      const block = workspace.newBlock('sscma_begin_serial');
      restoreNativeFields(block, { SERIAL: 'SerialCustom' });
      expect(block.getFieldValue('SERIAL')).toBe('SerialCustom');
      expect(() => restoreNativeFields(block, { SERIAL: 'UnknownPort' }))
        .toThrowError(/Cannot restore native field/);
    } finally { delete Blockly.Blocks['sscma_begin_serial']; }
  });

  it('adapts normalized U8G2 defaults for an older live library definition', () => {
    Blockly.Blocks['u8g2_begin'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([['SSD1306', 'SSD1306']]), 'TYPE')
        .appendField(new Blockly.FieldDropdown([['128x64 full', '128X64_NONAME_F']]), 'RESOLUTION')
        .appendField(new Blockly.FieldDropdown([['I2C', '_HW_I2C']]), 'PROTOCOL');
    } };
    try {
      const block = workspace.newBlock('u8g2_begin');
      const saved = { TYPE: 'SSD1306', MODE: 'FULL_BUFFER', RESOLUTION: '128X64_NONAME',
        PROTOCOL: '_HW_I2C', SCL_PIN: 'SCL', SDA_PIN: 'SDA', RESET_PIN: 'U8X8_PIN_NONE' };
      restoreNativeFields(block, saved);
      expect(block.getFieldValue('RESOLUTION')).toBe('128X64_NONAME_F');
      expect(saved.RESOLUTION).toBe('128X64_NONAME');
      expect(() => restoreNativeFields(block, { ...saved, SCL_PIN: '12' }))
        .toThrowError(/Cannot restore native field/);
    } finally { delete Blockly.Blocks['u8g2_begin']; }
  });

  it('loads the exact saved U8G2 font on an older picker without category fields', () => {
    Blockly.Blocks['u8g2_set_font'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([
        ['old Chinese font', 'u8g2_font_wqy13_t_chinese2'],
      ]), 'FONT');
    } };
    try {
      const block = workspace.newBlock('u8g2_set_font');
      restoreNativeFields(block, { SIZE: '14', FONT_TYPE: 'CHINESE', FONT: 'u8g2_font_wqy13_t_chinese2' });
      expect(block.getFieldValue('FONT')).toBe('u8g2_font_wqy13_t_chinese2');
      expect(() => restoreNativeFields(block, { SIZE: '15', FONT_TYPE: 'CHINESE',
        FONT: 'u8g2_font_wqy13_t_chinese2' })).toThrowError(/Cannot restore native field/);
    } finally { delete Blockly.Blocks['u8g2_set_font']; }
  });

  it('retains the old Chinese-1 font symbol when an old picker omits it', () => {
    Blockly.Blocks['u8g2_set_font'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([
        ['Chinese-2', 'u8g2_font_wqy12_t_chinese2'],
      ]), 'FONT');
    } };
    try {
      const block = workspace.newBlock('u8g2_set_font');
      restoreNativeFields(block, { SIZE: '8', FONT_TYPE: 'CHINESE', FONT: 'u8g2_font_wqy12_t_chinese1' });
      expect(block.getFieldValue('FONT')).toBe('u8g2_font_wqy12_t_chinese1');
      expect((block.getField('FONT') as Blockly.FieldDropdown).getOptions(false)
        .some(option => option[1] === 'u8g2_font_wqy12_t_chinese1')).toBeTrue();
    } finally { delete Blockly.Blocks['u8g2_set_font']; }
  });

  it('loads both published TFT setup shapes against the installed definition', () => {
    const names = ['WIDTH', 'HEIGHT', 'MISO', 'MOSI', 'SCLK', 'CS', 'DC', 'RST', 'BL'];
    const values = [240, 240, 0, 10, 12, 13, 14, 11, 16];
    const base = { VAR: 'tft', MODEL: 'GC9A01_DRIVER' };
    Blockly.Blocks['math_number'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldNumber(0), 'NUM'); this.setOutput(true);
    } };
    const install = (shape: 'inputs' | 'fields') => {
      Blockly.Blocks['tftespi_setup'] = { init() {
        this.appendDummyInput().appendField(new Blockly.FieldTextInput('tft'), 'VAR')
          .appendField(new Blockly.FieldDropdown([['GC9A01', 'GC9A01_DRIVER']]), 'MODEL');
        for (const name of names) {
          if (shape === 'inputs') this.appendValueInput(name);
          else this.appendDummyInput(name).appendField(new Blockly.FieldTextInput('0'), name);
        }
      } };
    };
    try {
      install('inputs');
      const old = { blocks: { blocks: [{ type: 'tftespi_setup', id: 'tft', fields: {
        ...base, ...Object.fromEntries(names.map((name, i) => [name, String(values[i])])),
        QSPI_CS: '13', QSPI_SCLK: '12', QSPI_RST: '11', D0: '-1', D1: '-1', D2: '-1', D3: '-1', TE: '-1',
      } }] } };
      const before = absJson(old);
      withNativeStateLoading(Blockly, workspace, old, () => Blockly.serialization.workspaces.load(old, workspace));
      expect(workspace.getBlockById('tft')!.getInputTargetBlock('WIDTH')!.getFieldValue('NUM')).toBe(240);
      expect(absJson(old)).toBe(before);
      workspace.clear();

      install('fields');
      const newer = { blocks: { blocks: [{ type: 'tftespi_setup', id: 'tft', fields: base,
        inputs: Object.fromEntries(names.map((name, i) => [name, { block: {
          type: 'math_number', id: `number-${i}`, fields: { NUM: values[i] },
        } }])),
      }] } };
      const newerBefore = absJson(newer);
      withNativeStateLoading(Blockly, workspace, newer, () => Blockly.serialization.workspaces.load(newer, workspace));
      expect(workspace.getBlockById('tft')!.getFieldValue('WIDTH')).toBe('240');
      expect(workspace.getAllBlocks(false).length).toBe(1);
      expect(absJson(newer)).toBe(newerBefore);
    } finally { delete Blockly.Blocks['tftespi_setup']; delete Blockly.Blocks['math_number']; }
  });

  it('bounds callbacks that continually replace one another', () => {
    const block = workspace.newBlock(type);
    block.getField = jasmine.createSpy().and.callFake(name => new Blockly.FieldTextInput());
    expect(() => restoreNativeFields(block, { A: 'kept' })).toThrowError(/did not stabilize/);
  });

  it('rejects ambiguous duplicate state IDs before native loading clears the workspace', () => {
    const original = workspace.newBlock(type, 'original');
    expect(() => load({ blocks: { blocks: [blockState(), blockState()] } })).toThrowError(/Duplicate block identity/);
    expect(workspace.getBlockById('original')).toBe(original);
  });
});
