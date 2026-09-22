import type * as Blockly from 'blockly';

export type NativeOwnedOperation = <T>(owner: string | undefined, operation: () => T) => T;

/** Synchronous creation provenance, local to one workspace and one execution phase.
 * Nested init calls inherit their caller's owner. No existing IDs are rewritten and no
 * callback output is promoted to user intent. Always restore the own descriptor.
 */
export function withNativeBlockCreation<T>(workspace: Blockly.Workspace,
  operation: (owned: NativeOwnedOperation) => T,
  created: (block: Blockly.Block, requestedId: string | undefined, owner: string | undefined) => void,
  allocate?: (type: string, id: string | undefined, owner: string | undefined) => string | undefined): T {
  const descriptor = Object.getOwnPropertyDescriptor(workspace, 'newBlock');
  const original = workspace.newBlock;
  let owner: string | undefined;
  const owned: NativeOwnedOperation = (next, action) => {
    const previous = owner; owner = next;
    try { return action(); } finally { owner = previous; }
  };
  Object.defineProperty(workspace, 'newBlock', { configurable: true, writable: true,
    value: function(this: Blockly.Workspace, type: string, id?: string) {
      if (this !== workspace) return original.call(this, type, id);
      return owned(owner ?? id, () => {
        const block = original.call(this, type, allocate ? allocate(type, id, owner) : id);
        created(block, id, owner);
        return block;
      });
    },
  });
  try { return operation(owned); }
  finally {
    if (descriptor) Object.defineProperty(workspace, 'newBlock', descriptor);
    else delete (workspace as any).newBlock;
  }
}

/** An explicit replacement may retire only a wholly-owned temporary subtree.
 * A shadow requires separately captured fallback evidence or authoritative ABI
 * topology; retirement itself never authorizes losing its persisted semantics.
 */
export function retireNativeInputDefault(connection: Blockly.Connection,
  owns: (block: Blockly.Block) => boolean, shadowPrepared = false): void {
  const root = connection.targetBlock();
  const hasShadow = !!connection.getShadowState() || !!connection.getShadowDom();
  if (!root && !hasShadow) return;
  if (!shadowPrepared && (hasShadow || root?.isShadow())) {
    throw new Error('Native default shadow requires explicit ownership; it cannot be discarded by ABS binding.');
  }
  const tree = root?.getDescendants(false) ?? [];
  if (root && (root.getParent() !== connection.getSourceBlock() || tree.some(block => !owns(block)))) {
    throw new Error('Native input replacement cannot retire an unowned or requested block.');
  }
  // Clear fallback before disconnecting, otherwise Blockly respawns another block.
  if (hasShadow) connection.setShadowState(null);
  if (root && !root.isDisposed()) root.dispose(false);
  if (connection.targetBlock() || tree.some(block => !block.isDisposed())) {
    throw new Error('Native input default did not retire completely.');
  }
}
