import * as Blockly from 'blockly';
import { batchBlocklyDragRenders } from './blockly-drag-render-batch';

describe('Blockly drag render batching', () => {
  let host: HTMLDivElement, workspace: Blockly.WorkspaceSvg;
  let release: () => void;
  const make = () => {
    const block = workspace.newBlock('drag_render_test');
    block.initSvg(); block.render(); return block;
  };
  beforeEach(() => {
    Blockly.Blocks['drag_render_test'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput('short'), 'TEXT');
      this.setPreviousStatement(true); this.setNextStatement(true);
    } };
    host = document.createElement('div'); host.style.cssText = 'width:800px;height:600px'; document.body.append(host);
    workspace = Blockly.inject(host, {});
    release = batchBlocklyDragRenders(workspace);
  });
  afterEach(() => { release(); workspace.dispose(); host.remove(); delete Blockly.Blocks['drag_render_test']; });

  it('coalesces legacy refresh loops while retaining final field and connection geometry', async () => {
    const first = make(), second = make();
    first.nextConnection!.connect(second.previousConnection!);
    await Blockly.renderManagement.finishQueuedRenders();
    const initialWidth = first.width;
    const render = spyOn(workspace.getRenderer(), 'render').and.callThrough();
    spyOn(workspace, 'isDragging').and.returnValue(true);
    first.setFieldValue('a substantially longer selected device label', 'TEXT');
    for (let i = 0; i < 30; i++) { first.render(); second.render(); }
    expect(render).not.toHaveBeenCalled();
    await Blockly.renderManagement.finishQueuedRenders();
    expect(render.calls.count()).toBe(2);
    expect(first.width).toBeGreaterThan(initialWidth);
    expect(first.nextConnection!.x).toBe(second.previousConnection!.x);
    expect(first.nextConnection!.y).toBe(second.previousConnection!.y);
    expect(first.getFieldValue('TEXT')).toContain('longer');
  });

  it('keeps initial layout, dragged blocks and ordinary edits synchronous', async () => {
    spyOn(workspace, 'isDragging').and.returnValue(true);
    const block = make();
    expect(block.height).toBeGreaterThan(0);
    const render = spyOn(workspace.getRenderer(), 'render').and.callThrough();
    block.setDragging(true); block.render();
    expect(render.calls.count()).toBe(1);
    block.setDragging(false);
    (workspace.isDragging as jasmine.Spy).and.returnValue(false);
    block.render(); expect(render.calls.count()).toBe(2);
    await Blockly.renderManagement.finishQueuedRenders();
  });

  it('ignores disposed queued blocks and restores the workspace when released', async () => {
    const block = make(), newBlock = workspace.newBlock;
    spyOn(workspace, 'isDragging').and.returnValue(true);
    block.render(); block.dispose(false);
    await Blockly.renderManagement.finishQueuedRenders();
    release();
    expect(workspace.newBlock).not.toBe(newBlock);
    const next = make();
    expect(Object.hasOwn(next, 'render')).toBeFalse();
    expect(Blockly.BlockSvg.prototype.render).toBe(next.render);
  });

  it('preserves library-specific render behavior', () => {
    let calls = 0;
    Blockly.Blocks['drag_render_custom'] = { init() {
      this.appendDummyInput().appendField('custom');
      this.render = function() { calls++; Blockly.BlockSvg.prototype.render.call(this); };
    } };
    try {
      const block = workspace.newBlock('drag_render_custom'); block.initSvg(); block.render();
      spyOn(workspace, 'isDragging').and.returnValue(true);
      block.render();
      expect(calls).toBe(2);
    } finally { delete Blockly.Blocks['drag_render_custom']; }
  });
});
