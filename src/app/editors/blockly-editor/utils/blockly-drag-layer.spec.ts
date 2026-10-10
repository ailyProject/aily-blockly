import * as Blockly from 'blockly';

describe('Blockly drag layer focus preservation', () => {
  let host: HTMLDivElement;
  let workspace: Blockly.WorkspaceSvg;
  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'width:800px;height:600px';
    document.body.append(host);
    workspace = Blockly.inject(host, {});
    Blockly.Blocks['drag_focus_probe'] = {init() {this.appendDummyInput().appendField('focus');}};
  });
  afterEach(() => {
    workspace.dispose(); host.remove();
    delete Blockly.Blocks['drag_focus_probe'];
  });

  function focusedBlock(): Blockly.BlockSvg {
    const block = workspace.newBlock('drag_focus_probe');
    block.initSvg(); block.render();
    Blockly.getFocusManager().focusNode(block);
    expect(document.activeElement).toBe(block.getFocusableElement());
    return block;
  }

  it('retains native focus across atomic SVG layer moves without blur', () => {
    const block = focusedBlock();
    const manager = workspace.getLayerManager()!;
    expect(typeof (manager.getDragLayer() as any).moveBefore).toBe('function');
    const blur = jasmine.createSpy('blur');
    block.getFocusableElement().addEventListener('blur', blur);
    manager.moveToDragLayer(block);
    expect(document.activeElement).toBe(block.getFocusableElement());
    manager.moveOffDragLayer(block, Blockly.layers.BLOCK);
    expect(document.activeElement).toBe(block.getFocusableElement());
    expect(blur).not.toHaveBeenCalled();
  });

  it('restores focus using the legacy path when atomic SVG moves are unavailable', () => {
    const block = focusedBlock();
    const manager = workspace.getLayerManager()!;
    for (const layer of [manager.getDragLayer(), manager.getBlockLayer()]) {
      Object.defineProperty(layer, 'moveBefore', {value: undefined, configurable: true});
    }
    manager.moveToDragLayer(block);
    expect(document.activeElement).toBe(block.getFocusableElement());
    manager.moveOffDragLayer(block, Blockly.layers.BLOCK);
    expect(document.activeElement).toBe(block.getFocusableElement());
  });

  it('keeps the focused block when front-ordering falls back to sibling insertion', async () => {
    const block = focusedBlock();
    const sibling = workspace.newBlock('drag_focus_probe');
    sibling.initSvg(); sibling.render();
    const parent = block.getSvgRoot().parentElement!;
    Object.defineProperty(parent, 'moveBefore', {value: undefined, configurable: true});
    block.moveSvgRootToFront(true);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(parent.lastElementChild).toBe(block.getSvgRoot());
    expect(sibling.getSvgRoot().parentElement).toBe(parent);
    expect(document.activeElement).toBe(block.getFocusableElement());
  });

  it('retains HTML border sizing inside SVG foreign objects with the scoped reset', () => {
    const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    const input = document.createElement('div');
    input.style.cssText = 'width:120px;height:40px;border:10px solid black';
    foreign.append(input); workspace.getCanvas().append(foreign);
    expect(getComputedStyle(input).boxSizing).toBe('border-box');
    expect(input.getBoundingClientRect().width).toBe(120);
    expect(getComputedStyle(workspace.getParentSvg()).boxSizing).toBe('border-box');
  });
});
