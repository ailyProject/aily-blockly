import * as Blockly from 'blockly';
import { withNativeBlockCreation } from '../services/blockly-native-block-effects';

const nativeQueueRender = Blockly.BlockSvg.prototype.queueRender;

/** While constructing one subtree, connection/field callbacks need to dirty
 * each new block, not walk the already loaded ancestor chain for every field.
 * Queue that chain once after the fragment, before the workspace batch flushes.
 * Custom queueRender implementations and existing blocks keep their semantics. */
export function withNativeFragmentRenders<T>(workspace: Blockly.WorkspaceSvg, load: () => T): T {
  const restore: Array<() => void> = [];
  const created = new Set<Blockly.BlockSvg>();
  try {
    return withNativeBlockCreation(workspace, () => load(), block => {
      if (!(block instanceof Blockly.BlockSvg) || block.queueRender !== nativeQueueRender) return;
      const descriptor = Object.getOwnPropertyDescriptor(block, 'queueRender');
      const original = block.queueRender;
      const queued = block.queueRender = function() {
        return this === block ? Blockly.renderManagement.queueRender(block, false) : original.call(this);
      };
      created.add(block);
      restore.push(() => {
        // A native extension may intentionally replace this instance's method.
        if (Object.getOwnPropertyDescriptor(block, 'queueRender')?.value !== queued) return;
        if (descriptor) Object.defineProperty(block, 'queueRender', descriptor);
        else delete (block as any).queueRender;
      });
    });
  } finally {
    for (const undo of restore.reverse()) undo();
    // Include the old parent of every fragment root. Never leave an existing
    // ancestor with stale geometry, including after a failed native callback.
    for (const block of created) {
      if (!block.isDisposed() && !created.has(block.getParent()!)) {
        Blockly.renderManagement.queueRender(block);
      }
    }
  }
}
