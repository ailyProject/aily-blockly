import * as Blockly from 'blockly';
import {BehaviorSubject} from 'rxjs';
import {BlocklyService} from '../src/app/editors/blockly-editor/services/blockly.service';
import {Multiselect} from '../src/app/editors/blockly-editor/components/blockly/plugins/workspace-multiselect/multiselect';
import {copyData, dragSelectionWeakMap, inMultipleSelectionModeWeakMap, multiDraggableWeakMap, shortcutNames} from '../src/app/editors/blockly-editor/components/blockly/plugins/workspace-multiselect/global';

for (const virtual of [false, true]) describe(`Multiselect cancellation (virtual=${virtual})`, () => {
  let host: HTMLDivElement;
  let workspace: Blockly.WorkspaceSvg;
  let plugin: any;
  let blocks: Blockly.BlockSvg[];
  let context: BlocklyService;
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  const selectedIds = () => dragSelectionWeakMap.get(workspace);
  const group = () => multiDraggableWeakMap.get(workspace);
  const shortcut = (name: string) => Blockly.ShortcutRegistry.registry.getRegistry()[name]
    .callback!(workspace, new KeyboardEvent('keydown', {cancelable: true}), null!, {});
  const click = (target: Element, shiftKey = false, button = 0) => {
    const rect = target.getBoundingClientRect();
    const options = {bubbles: true, cancelable: true, pointerId: 1,
      pointerType: 'mouse', isPrimary: true, button, shiftKey,
      clientX: rect.left + 10, clientY: rect.top + 10};
    target.dispatchEvent(new PointerEvent('pointerdown', {...options, buttons: button === 2 ? 2 : 1}));
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
    context = Object.create(BlocklyService.prototype);
    Object.assign(context, {_workspace: workspace,
      selectedBlockSubject: new BehaviorSubject<string | null>(null),
      selectedBlockIdsSubject: new BehaviorSubject<string[]>([])});
    workspace.addChangeListener(event => {
      if (event.type !== Blockly.Events.SELECTED) return;
      context.updateSelectedBlockFromEvent(event as Blockly.Events.Selected);
      queueMicrotask(() => context.syncSelectedBlocksFromWorkspace());
    });
    blocks = [0, 1].map(index => {
      const block = workspace.newBlock('deselect_probe');
      block.initSvg(); block.render(); block.moveBy(100 + index * 250, 100);
      return block;
    });
    await Blockly.renderManagement.finishQueuedRenders();
    await settle();
  });
  afterEach(async () => {
    Blockly.ContextMenu.hide();
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

  for (const multiple of [false, true]) {
    for (const tag of ['textarea', 'input', 'button', 'iframe']) {
      it(`retains ${multiple ? 'multiple' : 'single'} block context when ${tag} receives focus`, async () => {
        if (multiple) await selectAll();
        else {
          click(blocks[0].getSvgRoot().querySelector('.blocklyPath')!);
          await settle();
        }
        const expected = multiple ? blocks.map(block => block.id) : [blocks[0].id];
        expect(context.selectedBlockIdsSubject.value).toEqual(expected);
        const pane = document.createElement(tag);
        host.append(pane);
        if (pane instanceof HTMLIFrameElement) {
          const input = pane.contentDocument!.createElement('textarea');
          pane.contentDocument!.body.append(input);
          input.focus();
        } else pane.focus();
        await settle();
        expect(document.activeElement).toBe(pane);
        expect(context.selectedBlockIdsSubject.value).toEqual(expected);
        if (multiple) expect([...selectedIds()]).toEqual(expected);
        for (const id of expected) {
          expect(workspace.getBlockById(id)!.getSvgRoot().classList.contains('blocklySelected')).toBeTrue();
        }
        // Typing/Delete in Chat must never run the canvas delete shortcut.
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Delete', keyCode: 46, bubbles: true, cancelable: true,
        }));
        expect(workspace.getAllBlocks(false).length).toBe(2);
        pane.remove();
        click(host.querySelector('.blocklyMainBackground')!);
        await settle();
        expect(context.selectedBlockIdsSubject.value).toEqual([]);
        expectCleared();
      });
    }
  }

  for (const multiple of [false, true]) {
    for (const surface of ['root-focus', 'hover', 'host-background', 'injection-padding', 'svg-control']) {
      it(`keeps ${multiple ? 'multiple' : 'single'} selection on ${surface} until a real canvas click`, async () => {
        if (multiple) await selectAll();
        else {
          click(blocks[0].getSvgRoot().querySelector('.blocklyPath')!);
          await settle();
        }
        const expected = multiple ? blocks.map(block => block.id) : [blocks[0].id];
        const pane = document.createElement('div');
        host.append(pane);
        if (surface === 'root-focus') {
          Blockly.getFocusManager().focusNode(workspace.getRootFocusableNode());
        } else if (surface === 'hover') {
          const button = document.createElement('button');
          pane.append(button); button.focus();
          workspace.getInjectionDiv().dispatchEvent(new MouseEvent('mouseenter'));
        } else if (surface === 'host-background') {
          click(pane);
          Blockly.getFocusManager().focusNode(workspace.getRootFocusableNode());
        } else if (surface === 'injection-padding') {
          workspace.getInjectionDiv().append(pane);
          click(pane);
          Blockly.getFocusManager().focusNode(workspace.getRootFocusableNode());
        } else {
          const control = Blockly.utils.dom.createSvgElement('rect', {
            class: 'test-workspace-control', width: 20, height: 20,
          }, workspace.getParentSvg());
          click(control);
          control.remove();
        }
        await settle();
        expect(context.selectedBlockIdsSubject.value).toEqual(expected);
        if (multiple) expect([...selectedIds()]).toEqual(expected);
        for (const id of expected) {
          expect(workspace.getBlockById(id)!.getSvgRoot().classList.contains('blocklySelected')).toBeTrue();
        }
        pane.remove();
        click(host.querySelector('.blocklyMainBackground')!);
        await settle();
        expect(context.selectedBlockIdsSubject.value).toEqual([]);
        expectCleared();
      });
    }
  }

  it('does not restore a stale selection when a blank click follows selection in the same event batch', async () => {
    click(blocks[0].getSvgRoot().querySelector('.blocklyPath')!);
    click(host.querySelector('.blocklyMainBackground')!);
    await settle();
    expect(context.selectedBlockIdsSubject.value).toEqual([]);
    expectCleared();
  });

  it('right-clicks the target block and retains its context through the menu and Chat focus', async () => {
    click(blocks[0].getSvgRoot().querySelector('.blocklyPath')!);
    await settle();
    click(blocks[1].getSvgRoot().querySelector('.blocklyPath')!, false, 2);
    await settle();
    expect(Blockly.ContextMenu.getCurrentBlock()).toBe(blocks[1]);
    expect(Blockly.getSelected()).toBe(blocks[1]);
    expect(context.selectedBlockIdsSubject.value).toEqual([blocks[1].id]);
    Blockly.ContextMenu.hide();
    const input = document.createElement('textarea');
    host.append(input); input.focus();
    await settle();
    expect(context.selectedBlockIdsSubject.value).toEqual([blocks[1].id]);
    input.remove();
  });

  it('keeps all members when opening the menu on a selected block', async () => {
    await selectAll();
    click(blocks[1].getSvgRoot().querySelector('.blocklyPath')!, false, 2);
    await settle();
    expect(Blockly.ContextMenu.getCurrentBlock()).toBe(blocks[1]);
    expect([...selectedIds()]).toEqual(blocks.map(block => block.id));
    expect(context.selectedBlockIdsSubject.value).toEqual(blocks.map(block => block.id));
    Blockly.ContextMenu.hide();
    click(host.querySelector('.blocklyMainBackground')!);
    await settle();
    expectCleared();
    expect(context.selectedBlockIdsSubject.value).toEqual([]);
  });

  it('replaces the group when right-clicking an unselected block', async () => {
    await selectAll();
    const target = workspace.newBlock('deselect_probe');
    target.initSvg(); target.render(); target.moveBy(600, 300);
    await Blockly.renderManagement.finishQueuedRenders();
    click(target.getSvgRoot().querySelector('.blocklyPath')!, false, 2);
    await settle();
    expect(Blockly.ContextMenu.getCurrentBlock()).toBe(target);
    expect(Blockly.getSelected()).toBe(target);
    expect(selectedIds().size).toBe(0);
    expect(context.selectedBlockIdsSubject.value).toEqual([target.id]);
  });

  it('retains the group on field focus and a blur without a related target', async () => {
    await selectAll();
    Blockly.getFocusManager().focusNode(blocks[0].getField('TEXT')!);
    await settle();
    expect(context.selectedBlockIdsSubject.value).toEqual(blocks.map(block => block.id));
    Blockly.common.setSelected(group());
    (document.activeElement as HTMLElement).blur();
    await settle();
    expect(context.selectedBlockIdsSubject.value).toEqual(blocks.map(block => block.id));
    expect(selectedIds().size).toBe(2);
    click(host.querySelector('.blocklyMainBackground')!);
    await settle();
    expectCleared();
    expect(context.selectedBlockIdsSubject.value).toEqual([]);
  });

  it('leaves focus in Chat when leaving Shift selection mode', async () => {
    await selectAll();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Shift', keyCode: 16, shiftKey: true, bubbles: true,
    }));
    const input = document.createElement('textarea');
    host.append(input); input.focus();
    await settle();
    expect(document.activeElement).toBe(input);
    expect(inMultipleSelectionModeWeakMap.get(workspace)).toBeFalse();
    expect(context.selectedBlockIdsSubject.value).toEqual(blocks.map(block => block.id));
    input.remove();
  });

  it('clears the old group when selecting a block in a different workspace', async () => {
    await selectAll();
    const otherHost = document.createElement('div');
    otherHost.style.cssText = 'width:800px;height:600px';
    document.body.append(otherHost);
    const other = Blockly.inject(otherHost, {sounds: false});
    try {
      const block = other.newBlock('deselect_probe');
      block.initSvg(); block.render();
      Blockly.common.setSelected(block);
      await settle();
      expect(selectedIds().size).toBe(0);
      expect(context.selectedBlockIdsSubject.value).toEqual([]);
    } finally {
      other.dispose(); otherHost.remove();
    }
  });
});
