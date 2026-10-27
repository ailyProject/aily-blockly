import * as Blockly from 'blockly/core';
import { FieldImagePreview } from './field-image-preview';

describe('image editor geometry bindings', () => {
    let workspace: Blockly.Workspace;
    let block: Blockly.Block;
    let field: any;
    const flushEvents = () => new Promise<void>(resolve => setTimeout(resolve, 20));
    beforeEach(async () => {
        Blockly.Blocks['image_geometry_test'] = { init() {
            this.appendDummyInput()
                .appendField(new Blockly.FieldNumber(32, 1, 1000), 'WIDTH')
                .appendField(new Blockly.FieldNumber(32, 1, 1000), 'HEIGHT')
                .appendField(new Blockly.FieldNumber(0), 'X')
                .appendField(new Blockly.FieldNumber(0), 'Y')
                .appendField(FieldImagePreview.fromJson({ geometryFields: {
                    width: 'WIDTH', height: 'HEIGHT', x: 'X', y: 'Y',
                } }), 'IMAGE');
        } };
        workspace = new Blockly.Workspace();
        block = workspace.newBlock('image_geometry_test');
        field = block.getField('IMAGE');
        await flushEvents();
        workspace.clearUndo();
    });
    afterEach(() => { workspace.dispose(); delete Blockly.Blocks['image_geometry_test']; });

    it('reads generator parameters on editor open without changing serialized state', () => {
        field.setValue({ ...field.getValue(), width: 96, x: 5 });
        expect(block.getFieldValue('WIDTH')).toBe(32);
        expect(block.getFieldValue('X')).toBe(0);
        expect(field.editorGeometry('width', 100)).toBe(32);
        expect(field.getValue().width).toBe(96);
    });

    it('undoes and redoes editor state and all generator parameters together', async () => {
        const original = field.getValue();
        field.commitEditorValue({ ...original, width: 48, height: 24, x: 5, y: 7 });
        await flushEvents();
        expect(block.getFieldValue('WIDTH')).toBe(48);
        expect(block.getFieldValue('Y')).toBe(7);
        workspace.undo(false);
        expect(block.getFieldValue('WIDTH')).toBe(32);
        expect(block.getFieldValue('Y')).toBe(0);
        expect(field.getValue()).toEqual(original);
        await flushEvents();
        workspace.undo(true);
        expect(block.getFieldValue('WIDTH')).toBe(48);
        expect(field.getValue().x).toBe(5);
    });

    it('honors number validators and retains the surrounding event group', () => {
        block.getField('WIDTH')!.setValidator(() => 64);
        Blockly.Events.setGroup('outer-edit');
        try {
            field.commitEditorValue({ ...field.getValue(), width: 48 });
            expect(field.getValue().width).toBe(64);
            expect(Blockly.Events.getGroup()).toBe('outer-edit');
        } finally { Blockly.Events.setGroup(false); }
    });

    it('does not infer bindings for standalone image fields', () => {
        const standalone: any = FieldImagePreview.fromJson({});
        block.appendDummyInput().appendField(standalone, 'STANDALONE');
        standalone.commitEditorValue({ ...standalone.getValue(), width: 80 });
        expect(block.getFieldValue('WIDTH')).toBe(32);
        expect(standalone.getValue().width).toBe(80);
    });
});
