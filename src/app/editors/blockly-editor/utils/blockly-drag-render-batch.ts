import * as Blockly from 'blockly';

/** Legacy library callbacks call render() for every dependent dropdown. In
 * Blockly 13 each call also flushes the entire render queue and recomputes
 * connections/viewport geometry. During a drag, batch already-painted,
 * stationary blocks using the native frame queue. The dragged subtree and
 * newly created blocks still need synchronous geometry for snapping.
 *
 * Keep this workspace-local: flyouts, headless generation and other editors
 * retain their normal render contract. No model updates or events are delayed.
 */
export function batchBlocklyDragRenders(workspace: Blockly.WorkspaceSvg): () => void {
  const originals = new WeakMap<Blockly.BlockSvg, { descriptor?: PropertyDescriptor }>();
  const wrap = (block: Blockly.BlockSvg) => {
    // A library may implement additional behavior in its own render method.
    // Only replace the native immediate-flush convenience method.
    if (originals.has(block) || block.render !== Blockly.BlockSvg.prototype.render) return;
    const descriptor = Object.getOwnPropertyDescriptor(block, 'render');
    const render = block.render;
    originals.set(block, { descriptor });
    block.render = function() {
      if (workspace.isDragging() && this.height > 0 && !this.isDragging() && !this.isInsertionMarker()) {
        void this.queueRender();
        return;
      }
      render.call(this);
    };
  };
  workspace.getAllBlocks(false).forEach(wrap);
  const descriptor = Object.getOwnPropertyDescriptor(workspace, 'newBlock');
  const newBlock = workspace.newBlock;
  workspace.newBlock = function(...args) {
    const block = newBlock.apply(this, args);
    wrap(block);
    return block;
  };
  return () => {
    for (const block of workspace.getAllBlocks(false)) {
      const original = originals.get(block);
      if (!original) continue;
      if (original.descriptor) Object.defineProperty(block, 'render', original.descriptor);
      else delete (block as any).render;
    }
    if (descriptor) Object.defineProperty(workspace, 'newBlock', descriptor);
    else delete (workspace as any).newBlock;
  };
}
