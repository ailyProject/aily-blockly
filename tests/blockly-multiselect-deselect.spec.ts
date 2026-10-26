import * as Blockly from 'blockly';
import {Multiselect} from '../src/app/editors/blockly-editor/components/blockly/plugins/workspace-multiselect/multiselect';
import {copyData, dragSelectionWeakMap, inMultipleSelectionModeWeakMap, multiDraggableWeakMap, shortcutNames} from '../src/app/editors/blockly-editor/components/blockly/plugins/workspace-multiselect/global';

for (const virtual of [false, true]) describe(`Multiselect cancellation (virtual=${virtual})`, () => {
  let host: HTMLDivElement;
  let workspace: Blockly.WorkspaceSvg;
  let plugin: any;
  let blocks: Blockly.BlockSvg[];
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  const selectedIds = () => dragSelectionWeakMap.get(workspace);
  const group = () => multiDraggableWeakMap.get(workspace);
  const shortcut = (name: string) => Blockly.ShortcutRegistry.registry.getRegistry()[name]
    .callback!(workspace, new KeyboardEvent('keydown', {cancelable: true}), null!, {});
  const click = (target: Element, shiftKey = false) => {
    const rect = target.getBoundingClientRect();
    const options = {bubbles: true, cancelable: true, pointerId: 1,
      pointerType: 'mouse', isPrimary: true, button: 0, shiftKey,
      clientX: rect.left + 10, clientY: rect.top + 10};
    target.dispatchEvent(new PointerEvent('pointerdown', {...options, buttons: 1}));
    target.dispatchEvent(new PointerEvent('pointerup', {...options, buttons: 0}));
  };
  const escape = () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', keyCode: 27, bubbles: true, cancelable: true,
  }));
  const selectAll = async (menu = false) => {
    if (menu) {
      Blockly.ContextMenuRegistry.registry.getItem('workspaceSelectAll')!
        .callback!({workspace}, new PointerEvent('pointerdown'), new MouseEvent('click'), new Blockly.utils.Coordinate(0, 0));
    } else {
      shortcut('selectall');
    }
    await settle();
    expect(selectedIds().size).toBe(2);
    expect(Blockly.getSelected()).toBe(group());
  };
  const expectCleared = () => {
    expect(Blockly.getSelected()).toBeNull();
    expect(selectedIds().size).toBe(0);
    expect(group().subDraggables.size).toBe(0);
    for (const block of blocks) {
      expect(block.getSvgRoot().classList.contains('blocklySelected')).toBeFalse();
      expect((block as any).pointerDownHandler).toBeUndefined();
    }
  };

  beforeEach(async () => {
    host = document.createElement('div');
    host.style.cssText = 'width:800px;height:600px';
    document.body.append(host);
    Blockly.Blocks['deselect_probe'] = {init() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput('probe'), 'TEXT');
      this.setPreviousStatement(true);
      this.setNextStatement(true);
    }};
    workspace = Blockly.inject(host, {sounds: false, renderer: 'zelos'});
    workspace.setViewportRendering(virtual);
    plugin = new Multiselect(workspace);
    plugin.init({multiselectIcon: {hideIcon: true}, multiSelectKeys: ['Shift'],
      multiselectCopyPaste: {crossTab: false}});
    blocks = [0, 1].map(index => {
      const block = workspace.newBlock('deselect_probe');
      block.initSvg(); block.render(); block.moveBy(100 + index * 250, 100);
      return block;
    });
    await Blockly.renderManagement.finishQueuedRenders();
    await settle();
  });
  afterEach(async () => {
    plugin.dispose();
    workspace.dispose(); host.remove();
    delete Blockly.Blocks['deselect_probe'];
    copyData.clear();
    await settle();
  });

  for (const menu of [false, true]) it(`clears ${menu ? 'menu' : 'keyboard'} select-all on a blank canvas click`, async () => {
    await selectAll(menu);
    click(host.querySelector('.blocklyMainBackground')!);
    await settle();
    expectCleared();
    click(blocks[0].getSvgRoot().querySelector('.blocklyPath')!);
    await settle();
    expect(Blockly.getSelected()).toBe(blocks[0]);
    expect(selectedIds().size).toBe(0);
  });

  it('clears the group with Escape and makes Delete harmless afterwards', async () => {
    await selectAll();
    escape();
    await settle();
    expectCleared();
    shortcut(shortcutNames.MULTIDELETE);
    expect(workspace.getAllBlocks(false).length).toBe(2);
  });

  it('preserves the group on a selected block click and for copy and drag', async () => {
    await selectAll();
    click(blocks[0].getSvgRoot().querySelector('.blocklyPath')!);
    await settle();
    expect(Blockly.getSelected()).toBe(group());
    expect(selectedIds().size).toBe(2);
    shortcut(shortcutNames.MULTICOPY);
    expect(copyData.size).toBe(2);
    const before = blocks.map(block => block.getRelativeToSurfaceXY().clone());
    group().startDrag();
    group().drag(new Blockly.utils.Coordinate(35, 22));
    group().endDrag(undefined, Blockly.DragDisposition.COMMIT);
    await settle();
    blocks.forEach((block, i) => {
      expect(block.getRelativeToSurfaceXY().x).toBe(before[i].x + 35);
      expect(block.getRelativeToSurfaceXY().y).toBe(before[i].y + 22);
    });
    expect(selectedIds().size).toBe(2);
  });

  it('leaves Escape in text inputs and open field widgets to their own handlers', async () => {
    await selectAll();
    const input = document.createElement('input');
    workspace.getInjectionDiv().append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', keyCode: 27, bubbles: true, cancelable: true,
    }));
    await settle();
    expect(selectedIds().size).toBe(2);
    input.remove();
    Blockly.WidgetDiv.show(blocks[0].getField('TEXT')!, false, () => {});
    escape();
    await settle();
    expect(selectedIds().size).toBe(2);
    Blockly.WidgetDiv.hide();
  });

  it('keeps the group when Shift starts additive selection on the canvas', async () => {
    await selectAll();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Shift', keyCode: 16, shiftKey: true, bubbles: true,
    }));
    click(host.querySelector('.blocklyMainBackground')!, true);
    await settle();
    expect(inMultipleSelectionModeWeakMap.get(workspace)).toBeTrue();
    expect(selectedIds().size).toBe(2);
    escape();
    await settle();
    expect(inMultipleSelectionModeWeakMap.get(workspace)).toBeFalse();
    expectCleared();
  });
});
