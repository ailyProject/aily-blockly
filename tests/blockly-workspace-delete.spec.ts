import * as Blockly from 'blockly';
import { installBlocklyWorkspaceDelete } from '../src/app/editors/blockly-editor/utils/blockly-workspace-delete';

describe('workspace Delete All', () => {
  let workspace: Blockly.Workspace;
  let host: HTMLDivElement | undefined;
  let confirm: jasmine.Spy;
  const menu = () => Blockly.ContextMenuRegistry.registry.getItem('workspaceDelete')!;
  const scope = () => ({ workspace: workspace as Blockly.WorkspaceSvg });
  const label = () => {
    const displayText = menu().displayText;
    return typeof displayText === 'function' ? displayText(scope()) : displayText;
  };
  const removeAll = () => menu().callback!(scope(), new PointerEvent('pointerdown'),
    new MouseEvent('click'), new Blockly.utils.Coordinate(0, 0));
  const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 30)));
  const withoutEvents = (action: () => void) => {
    Blockly.Events.disable();
    try { action(); } finally { Blockly.Events.enable(); }
  };
  const createTree = (count: number, chain = false) => {
    const blocks: Blockly.Block[] = [];
    withoutEvents(() => {
      for (let i = 0; i < count; i++) {
        const block = workspace.newBlock('workspace_delete_probe', `delete_${i}`);
        if (block instanceof Blockly.BlockSvg) block.initSvg();
        blocks.push(block);
      }
      for (let i = count - 1; i > 0; i--) {
        const parent = blocks[chain ? i - 1 : Math.floor((i - 1) / 2)];
        (chain ? parent.nextConnection : parent.getInput(i % 2 ? 'LEFT' : 'RIGHT')!.connection)!
          .connect(blocks[i].previousConnection!);
      }
    });
    return blocks;
  };

  beforeEach(() => {
    installBlocklyWorkspaceDelete();
    Blockly.Blocks['workspace_delete_probe'] = { init() {
      this.setPreviousStatement(true); this.setNextStatement(true);
      this.appendStatementInput('LEFT'); this.appendStatementInput('RIGHT');
    } };
    workspace = new Blockly.Workspace();
    // The same registered UI callback can exercise a real headless model.
    (workspace as Blockly.WorkspaceSvg).cancelCurrentGesture = () => {};
    confirm = jasmine.createSpy('confirm').and.callFake((_message, callback) => callback(true));
    Blockly.dialog.setConfirm(confirm);
  });

  afterEach(async () => {
    Blockly.Events.setGroup(false);
    withoutEvents(() => {
      // Safe cleanup even when an assertion exposes a native disposal failure.
      for (const block of workspace.getAllBlocks(false)) block.unplug(false);
      workspace.dispose();
    });
    host?.remove(); host = undefined;
    delete Blockly.Blocks['workspace_delete_probe'];
    Blockly.dialog.setConfirm();
    await settle();
  });

  it('deletes a 10000-block tree without recursively skipping its disposed descendants', async () => {
    createTree(10000);
    expect(label()).toContain('10000');
    removeAll();
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(workspace.getAllBlocks(false)).toEqual([]);
    expect(Blockly.Events.getGroup()).toBe('');
  }, 30000);

  for (const virtual of [false, true]) {
    it(`deletes 717 rendered connected blocks and restores them with one undo (virtual=${virtual})`, async () => {
      workspace.dispose();
      host = document.createElement('div'); host.style.cssText = 'width:800px;height:600px'; document.body.append(host);
      workspace = Blockly.inject(host, { sounds: false, media: '', comments: true });
      (workspace as Blockly.WorkspaceSvg).setViewportRendering(virtual);
      const blocks = createTree(717, true);
      blocks[0].setCommentText('keep this comment');
      await Blockly.renderManagement.finishQueuedRenders(); await settle();
      workspace.clearUndo();
      const saved = Blockly.serialization.workspaces.save(workspace);
      removeAll(); await settle();
      expect(workspace.getAllBlocks(false)).toEqual([]);
      expect(new Set(workspace.getUndoStack().map(event => event.group)).size).toBe(1);
      workspace.undo(false); await Blockly.renderManagement.finishQueuedRenders(); await settle();
      expect(workspace.getAllBlocks(false).length).toBe(717);
      expect(Blockly.serialization.workspaces.save(workspace)).toEqual(saved);
      workspace.undo(true); await settle();
      expect(workspace.getAllBlocks(false)).toEqual([]);
    }, 30000);
  }

  it('keeps protected roots, deletes their deletable subtrees, and retains variables', async () => {
    const blocks = createTree(7);
    blocks[0].setDeletable(false); blocks[1].setDeletable(false);
    workspace.getVariableMap().createVariable('kept', '', 'kept_variable');
    expect(label()).toContain('5');
    removeAll(); await settle();
    expect(workspace.getAllBlocks(false).map(block => block.id).sort()).toEqual(['delete_0', 'delete_1']);
    expect(workspace.getVariableMap().getVariableById('kept_variable')?.getName()).toBe('kept');
    expect(menu().preconditionFn(scope(), new MouseEvent('contextmenu'))).toBe('disabled');
  });

  it('preserves every block when confirmation is cancelled', () => {
    createTree(7); confirm.and.callFake((_message, callback) => callback(false));
    const saved = Blockly.serialization.workspaces.save(workspace);
    removeAll();
    expect(Blockly.serialization.workspaces.save(workspace)).toEqual(saved);
    expect(workspace.getUndoStack()).toEqual([]);
  });

  it('does not confirm a single block and restores the caller event group', () => {
    createTree(1);
    Blockly.Events.setGroup('caller');
    removeAll();
    expect(confirm).not.toHaveBeenCalled();
    expect(workspace.getAllBlocks(false)).toEqual([]);
    expect(Blockly.Events.getGroup()).toBe('caller');
  });

  it('groups multiple animated root deletions into one undo and leaves intervening events alone', async () => {
    createTree(7);
    withoutEvents(() => { workspace.newBlock('workspace_delete_probe', 'second_root'); });
    const savedRoot = Blockly.serialization.blocks.save(workspace.getBlockById('delete_0')!);
    removeAll();
    expect(workspace.getAllBlocks(false).length).toBe(1);
    Blockly.Events.setGroup('intervening');
    await settle();
    expect(workspace.getAllBlocks(false)).toEqual([]);
    expect(Blockly.Events.getGroup()).toBe('intervening');
    Blockly.Events.setGroup(false);
    expect(new Set(workspace.getUndoStack().map(event => event.group)).size).toBe(1);
    workspace.undo(false); await settle();
    expect(workspace.getAllBlocks(false).length).toBe(8);
    expect(Blockly.serialization.blocks.save(workspace.getBlockById('delete_0')!)).toEqual(savedRoot);
    expect(workspace.getBlockById('second_root')).not.toBeNull();
    workspace.undo(true); await settle();
    expect(workspace.getAllBlocks(false)).toEqual([]);
  });

  it('iterates past queued roots removed by another action during the animation', () => {
    const blocks: Blockly.Block[] = [];
    withoutEvents(() => {
      for (let i = 0; i < 10000; i++) blocks.push(workspace.newBlock('workspace_delete_probe'));
    });
    jasmine.clock().install();
    try {
      removeAll();
      withoutEvents(() => { for (const block of blocks.slice(1)) block.dispose(false); });
      jasmine.clock().tick(10);
      expect(workspace.getAllBlocks(false)).toEqual([]);
      expect(Blockly.Events.getGroup()).toBe('');
    } finally { jasmine.clock().uninstall(); }
  }, 30000);

  it('restores the caller group when a library deletion hook throws', () => {
    const [block] = createTree(1);
    const dispose = spyOn(block, 'dispose').and.throwError('library destroy failed');
    try {
      Blockly.Events.setGroup('caller');
      expect(removeAll).toThrowError('library destroy failed');
      expect(Blockly.Events.getGroup()).toBe('caller');
    } finally { dispose.and.callThrough(); }
  });
});
