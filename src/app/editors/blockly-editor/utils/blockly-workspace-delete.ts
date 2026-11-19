import * as Blockly from 'blockly';

interface WorkspaceDeletion {
  roots: Blockly.BlockSvg[];
  count: number;
}

/** Match native deletion rules: retain a protected root, but visit its children.
 * A deletable root already owns its descendants; queue it only once. */
function collectWorkspaceDeletion(workspace: Blockly.WorkspaceSvg): WorkspaceDeletion {
  const roots: Blockly.BlockSvg[] = [];
  const pending = workspace.getTopBlocks(true).reverse();
  let count = 0;
  while (pending.length) {
    const block = pending.pop()!;
    if (block.isDeletable()) {
      roots.push(block);
      count += block.getDescendants(false).length;
    } else {
      const children = block.getChildren(false);
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
    }
  }
  return { roots, count };
}

function deleteWorkspaceRoots(roots: readonly Blockly.BlockSvg[]): void {
  const group = Blockly.Events.getGroup() || Blockly.utils.idGenerator.genUid();
  let index = 0;
  const next = () => {
    const previousGroup = Blockly.Events.getGroup();
    try {
      Blockly.Events.setGroup(group);
      while (index < roots.length) {
        const block = roots[index++];
        // Another action may have removed a queued root during the animation.
        if (block.isDeadOrDying()) continue;
        block.dispose(false, true);
        if (index < roots.length) setTimeout(next, 10);
        return;
      }
    } finally {
      Blockly.Events.setGroup(previousGroup);
    }
  };
  next();
}

let installed = false;

/** The pinned 1.0.6 menu recursively skips every descendant after deleting its
 * root. Large trees exhaust the stack in that timer even though disposal has
 * finished. Keep native disposal/undo/animation, with a queue of roots only. */
export function installBlocklyWorkspaceDelete(): void {
  if (installed) return;
  const native = Blockly.ContextMenuRegistry.registry.getItem('workspaceDelete');
  if (!native || native.separator) return;
  const { separator: _separator, ...action } = native;
  const replacement: Blockly.ContextMenuRegistry.RegistryItem = {
    ...action,
    displayText(scope) {
      if (!scope.workspace) return '';
      const { count } = collectWorkspaceDeletion(scope.workspace);
      return count === 1 ? Blockly.Msg['DELETE_BLOCK']
        : Blockly.Msg['DELETE_X_BLOCKS'].replace('%1', String(count));
    },
    preconditionFn(scope) {
      return scope.workspace && collectWorkspaceDeletion(scope.workspace).count > 0 ? 'enabled' : 'disabled';
    },
    callback(scope) {
      if (!scope.workspace) return;
      scope.workspace.cancelCurrentGesture();
      const { roots, count } = collectWorkspaceDeletion(scope.workspace);
      if (count < 2) deleteWorkspaceRoots(roots);
      else Blockly.dialog.confirm(Blockly.Msg['DELETE_ALL_BLOCKS'].replace('%1', String(count)), confirmed => {
        if (confirmed) deleteWorkspaceRoots(roots);
      });
    },
  };
  Blockly.ContextMenuRegistry.registry.unregister(native.id);
  Blockly.ContextMenuRegistry.registry.register(replacement);
  installed = true;
}
