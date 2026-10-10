import * as Blockly from 'blockly';
import {MultiselectDraggable} from '../components/blockly/plugins/workspace-multiselect/multiselect_draggable';
import {dragSelectionWeakMap, inMultipleSelectionModeWeakMap} from '../components/blockly/plugins/workspace-multiselect/global';

for (const virtual of [false, true]) describe(`Blockly v13 rendered multiselect (virtual=${virtual})`, () => {
  let workspace: Blockly.WorkspaceSvg;
  let div: HTMLDivElement;
  let selection: any;
  let blocks: Blockly.BlockSvg[];
  beforeEach(async () => {
    div = document.createElement('div');
    div.style.cssText = 'width:800px;height:600px';
    document.body.appendChild(div);
    workspace = Blockly.inject(div, {media: '', sounds: false});
    workspace.setViewportRendering(virtual);
    Blockly.Blocks['multiselect_probe'] = {init() {
      this.appendDummyInput().appendField('probe');
      this.setPreviousStatement(true);
      this.setNextStatement(true);
    }};
    dragSelectionWeakMap.set(workspace, new Set());
    inMultipleSelectionModeWeakMap.set(workspace, false);
    selection = new MultiselectDraggable(workspace);
    blocks = [0, 1].map(i => {
      const block = workspace.newBlock('multiselect_probe');
      block.initSvg(); block.render(); block.moveBy(100 + i * 200, 100);
      selection.addSubDraggable_(block);
      return block;
    });
    await Blockly.renderManagement.finishQueuedRenders();
  });
  afterEach(() => {
    selection.disposeFocus();
    workspace.dispose(); div.remove();
    delete Blockly.Blocks['multiselect_probe'];
  });

  it('focuses the group and clears selection through the workspace root', () => {
    Blockly.common.setSelected(selection);
    expect(Blockly.getSelected()).toBe(selection);
    expect(document.activeElement).toBe(selection.getFocusableElement());
    Blockly.getFocusManager().focusNode(workspace.getRootFocusableNode());
    expect(Blockly.getSelected()).toBeNull();
  });

  it('returns a valid drag target and moves every block by the same delta', () => {
    const before = blocks.map(block => block.getRelativeToSurfaceXY().clone());
    expect(selection.startDrag()).toBe(selection);
    selection.drag(new Blockly.utils.Coordinate(35, 22));
    selection.endDrag(undefined, Blockly.DragDisposition.COMMIT);
    blocks.forEach((block, i) => {
      expect(block.getRelativeToSurfaceXY().x).toBe(before[i].x + 35);
      expect(block.getRelativeToSurfaceXY().y).toBe(before[i].y + 22);
    });
  });

  it('preserves selected stack connections and can revert movement', () => {
    blocks[0].nextConnection!.connect(blocks[1].previousConnection!);
    const before = blocks[0].getRelativeToSurfaceXY().clone();
    selection.startDrag();
    selection.drag(new Blockly.utils.Coordinate(40, 20));
    selection.revertDrag();
    selection.endDrag(undefined, Blockly.DragDisposition.REVERT);
    expect(blocks[0].getNextBlock()).toBe(blocks[1]);
    expect(blocks[0].getRelativeToSurfaceXY()).toEqual(before);
  });

  it('retains the whole pasted group after deferred BlockPaster focus', async () => {
    selection.clearAll_();
    for (const block of blocks) {
      const pasted = Blockly.clipboard.paste(block.toCopyData()!, workspace);
      selection.addSubDraggable_(pasted);
    }
    await selection.selectAfterRender();
    expect(Blockly.getSelected()).toBe(selection);
    expect(selection.subDraggables.size).toBe(2);
  });
});
