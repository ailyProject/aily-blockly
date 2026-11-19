import * as Blockly from 'blockly';
import {installBlocklyInteractionRecovery} from '../src/app/editors/blockly-editor/utils/blockly-interaction-recovery';

for (const renderer of ['zelos', 'thrasos', 'geras']) {
  describe(`Viewport focus with ${renderer}`, () => {
    let host: HTMLDivElement;
    let workspace: Blockly.WorkspaceSvg;
    let blocks: Blockly.BlockSvg[];
    beforeAll(() => installBlocklyInteractionRecovery());
    beforeEach(async () => {
      host = document.createElement('div');
      host.style.cssText = 'width:800px;height:600px';
      document.body.append(host);
      Blockly.Blocks['viewport_focus_probe'] = {init() {
        this.appendDummyInput().appendField(new Blockly.FieldTextInput('item'), 'TEXT');
        this.setPreviousStatement(true);
        this.setNextStatement(true);
      }};
      workspace = Blockly.inject(host, {renderer, sounds: false});
      workspace.setViewportRendering(true);
      blocks = [0, 1, 2].map(() => {
        const block = workspace.newBlock('viewport_focus_probe');
        block.initSvg(); block.render();
        return block;
      });
      blocks[0].nextConnection!.connect(blocks[1].previousConnection!);
      blocks[1].nextConnection!.connect(blocks[2].previousConnection!);
      blocks[0].moveBy(100, 100);
      await Blockly.renderManagement.finishQueuedRenders();
      workspace.getViewportRenderer()!.refresh();
    });
    afterEach(() => {
      workspace.dispose(); host.remove();
      delete Blockly.Blocks['viewport_focus_probe'];
    });

    it('selects a stack root after its child without reentering focus', () => {
      const focus = Blockly.getFocusManager();
      focus.focusNode(blocks[2]);
      // Zelos appends its selected outline after the flattened child views.
      // The subsequent paint-order refresh must leave focus to this transaction.
      expect(() => focus.focusNode(blocks[0])).not.toThrow();
      expect(focus.getFocusedNode()).toBe(blocks[0]);
      expect(document.activeElement).toBe(blocks[0].getFocusableElement());
      expect((focus as any).lockFocusStateChanges).toBeFalse();
      expect((focus as any).isUpdatingFocusedNode).toBeFalse();
    });

    it('still preserves field focus across an ordinary topology refresh', async () => {
      const focus = Blockly.getFocusManager(), field = blocks[2].getField('TEXT')!;
      focus.focusNode(field);
      blocks[1].unplug();
      await Blockly.renderManagement.finishQueuedRenders();
      workspace.getViewportRenderer()!.refresh();
      expect(focus.getFocusedNode()).toBe(field);
      expect(document.activeElement).toBe(field.getFocusableElement());
    });
  });
}
