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
