import * as Blockly from 'blockly';
import { createBrowserFrameBudget } from '@shared/public-api';
import { withNativeStateLoading } from '../../../editors/blockly-editor/services/blockly-native-state-loading';
import { primeBlocklyTextWidths } from '../../../editors/blockly-editor/utils/blockly-text-measurement';

type BlockState = Blockly.serialization.blocks.State;

interface PendingFragment {
  state: BlockState;
  parent?: { id: string; input?: string };
}

const BLOCKS_PER_BATCH = 64;
const BLOCKS_PER_FRAGMENT = 32;

/** Cut only real connections; fields, mutators and fallback shadow trees stay intact. */
function takeFragment(source: BlockState, budget: number): {
  state: BlockState;
  deferred: PendingFragment[];
  blockCount: number;
} {
  const deferred: PendingFragment[] = [];
  let blockCount = 0;

  const visit = (block: BlockState): BlockState => {
    blockCount++;
    const state: BlockState = { ...block, id: block.id || Blockly.utils.idGenerator.genUid() };

    const connection = (
      slot: Blockly.serialization.blocks.ConnectionState,
      input?: string,
    ): Blockly.serialization.blocks.ConnectionState => {
      if (!slot.block) return slot;
      if (blockCount < budget) return { ...slot, block: visit(slot.block) };

      deferred.push({ state: slot.block, parent: { id: state.id!, input } });
      const { block: _block, ...remaining } = slot;
      return remaining;
    };

    if (block.inputs) {
      state.inputs = Object.fromEntries(
        Object.entries(block.inputs).map(([name, slot]) => [name, connection(slot, name)]),
      );
    }
    if (block.next) state.next = connection(block.next);
    return state;
  };

  const state = visit(source);
  return { state, deferred, blockCount };
}

export async function loadAbsWorkspaceInChunks(
  abi: Record<string, any>,
  workspace: Blockly.WorkspaceSvg,
  onProgress?: (blocks: number, batches: number) => void,
  assertCurrent: () => void = () => undefined,
  fieldOrder?: (block: Blockly.Block) => readonly string[] | undefined,
): Promise<{ blockCount: number; batchCount: number }> {
  // appendInternal is exported by the bundled Blockly runtime. It preserves
  // parent-before-field loading and queues rendering instead of forcing it.
  if (typeof Blockly.serialization.blocks.appendInternal !== 'function') {
    throw new Error('当前 Blockly 运行时不支持 ABS 切片装载。');
  }

  assertCurrent();
  const pending: PendingFragment[] = (abi['blocks']?.blocks || [])
    .map((state: BlockState) => ({ state }))
    .reverse();
  let blockCount = 0;
  let batchCount = 0;
  // Keep models complete while yielding input handling between fragments.
  // Geometry and the viewport index are refreshed after the graph is connected,
  // rather than repeatedly rendering a growing long stack at every browser frame.
  const beginBatch = (Blockly.renderManagement as typeof Blockly.renderManagement & {
    beginWorkspaceRenderBatch?: (workspace: Blockly.WorkspaceSvg) => () => void;
  }).beginWorkspaceRenderBatch;
  const release = beginBatch?.(workspace) ?? (() => Blockly.renderManagement.triggerQueuedRenders(workspace));
  // A yielded frame must not lay out thousands of partially connected SVGs.
  // Restore the canvas before measuring fonts/final geometry. Only presentation
  // is hidden: every model and native connection is still created normally.
  const canvas = workspace.rendered ? workspace.getCanvas() : null;
  const placeholder = canvas?.parentNode ? document.createComment('blockly-loading') : null;
  if (placeholder) canvas!.replaceWith(placeholder);
  const budget = createBrowserFrameBudget({ budgetMs: 16 });
  try {
    Blockly.serialization.workspaces.load({
      ...abi,
      blocks: { ...abi['blocks'], blocks: [] },
    }, workspace);
    while (pending.length > 0) {
      assertCurrent();
      let batchBlocks = 0;
      while (pending.length > 0 && batchBlocks < BLOCKS_PER_BATCH) {
        assertCurrent();
        const item = pending.pop()!;
        const fragment = takeFragment(item.state, Math.min(BLOCKS_PER_FRAGMENT, BLOCKS_PER_BATCH - batchBlocks));
        const parent = item.parent ? workspace.getBlockById(item.parent.id) : undefined;
        const parentConnection = item.parent
          ? item.parent.input !== undefined
            ? parent?.getInput(item.parent.input)?.connection
            : parent?.nextConnection
          : undefined;
        if (item.parent && !parentConnection) {
          throw new Error(`ABS 切片连接不存在: ${item.parent.id}/${item.parent.input ?? 'next'}`);
        }

        const group = Blockly.Events.getGroup(), recordUndo = Blockly.Events.getRecordUndo();
        try {
          withNativeStateLoading(Blockly, workspace, fragment.state, () => Blockly.serialization.blocks.appendInternal(fragment.state, workspace, {
            parentConnection: parentConnection || undefined,
            recordUndo: false,
          }), fieldOrder);
        } finally {
          // Native appendInternal restores these only on success. A rejected
          // library field/type must not change the next project's undo policy.
          Blockly.Events.setGroup(group); Blockly.Events.setRecordUndo(recordUndo);
        }
        pending.push(...fragment.deferred.reverse());
        batchBlocks += fragment.blockCount;
        await budget.checkpoint('abs.native-load');
        assertCurrent();
      }

      blockCount += batchBlocks;
      batchCount++;
      onProgress?.(blockCount, batchCount);
      await budget.checkpoint('abs.native-load');
    }
    assertCurrent();
  } finally {
    if (placeholder) placeholder.replaceWith(canvas!);
    Blockly.utils.dom.startTextWidthCache();
    try {
      // Read fonts before the final geometry pass, not between SVG writes.
      if (workspace.rendered && workspace.getAllBlocks(false).length >= 1000) primeBlocklyTextWidths(workspace);
    } finally {
      try { release(); } finally { Blockly.utils.dom.stopTextWidthCache(); }
    }
  }
  assertCurrent();
  return { blockCount, batchCount };
}
