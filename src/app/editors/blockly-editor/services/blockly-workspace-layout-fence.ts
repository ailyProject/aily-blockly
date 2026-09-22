import type * as Blockly from 'blockly';

/** An exclusive document transaction owns root coordinates. Native redraws may
 * still run, but interactive collision avoidance must not move its snapshot.
 * Instance-local hooks also cover newly loaded/rollback blocks; no flags, global
 * prototypes, connection tracking or persisted data are changed.
 */
export function fenceBlocklyWorkspaceBumps(workspace: Blockly.Workspace): () => void {
  if (!workspace.rendered) return () => undefined;
  const restore: Array<() => void> = [];
  const fenced = new WeakSet<Blockly.Block>();
  const fence = (block: Blockly.Block) => {
    if (fenced.has(block)) return;
    const descriptor = Object.getOwnPropertyDescriptor(block, 'moveBy'), moveBy = block.moveBy;
    Object.defineProperty(block, 'moveBy', { configurable: true, writable: true,
      value: function(this: Blockly.Block, dx: number, dy: number, reason?: string[]) {
        if (this === block && reason?.length === 1 && reason[0] === 'bump') return;
        return moveBy.call(this, dx, dy, reason);
      },
    });
    fenced.add(block);
    restore.push(() => {
      if (descriptor) Object.defineProperty(block, 'moveBy', descriptor);
      else delete (block as any).moveBy;
    });
  };
  const release = () => { for (const undo of restore.splice(0).reverse()) undo(); };
  try {
    workspace.getAllBlocks(false).forEach(fence);
    const descriptor = Object.getOwnPropertyDescriptor(workspace, 'newBlock'), newBlock = workspace.newBlock;
    Object.defineProperty(workspace, 'newBlock', { configurable: true, writable: true,
      value: function(this: Blockly.Workspace, ...args: Parameters<typeof newBlock>) {
        const block = newBlock.apply(this, args);
        if (this === workspace) fence(block);
        return block;
      },
    });
    restore.push(() => {
      if (descriptor) Object.defineProperty(workspace, 'newBlock', descriptor);
      else delete (workspace as any).newBlock;
    });
    return release;
  } catch (error) { release(); throw error; }
}
