import * as Blockly from 'blockly';
import { primeBlocklyTextWidths } from './blockly-text-measurement';

/** Blockly queues renders during JSON loading, but closes its text cache before
 * the animation frame runs. Flush that batch while the cache is still active;
 * do not render the entire workspace a second time after loading. */
export function loadBlocklyWorkspace(workspace: Blockly.WorkspaceSvg, state: object): void {
  const recordUndo = Blockly.Events.getRecordUndo();
  const group = Blockly.Events.getGroup();
  const serializer = Blockly.registry.getObject<Blockly.serialization.blocks.BlockSerializer>(Blockly.registry.Type.SERIALIZER, 'blocks');
  const originalLoad = serializer?.load;
  const ownLoad = serializer && Object.getOwnPropertyDescriptor(serializer, 'load');
  const useBatch = workspace.rendered && serializer
    && originalLoad === Blockly.serialization.blocks.BlockSerializer.prototype.load;
  // Keep workspaces.load responsible for serializer order, variables, events
  // and cleanup. Only defer the built-in block serializer's per-root flush so
  // all font reads can happen before SVG layout starts. Custom serializers and
  // reentrant loads keep their original path. This override is synchronous.
  if (useBatch) {
    let loading = false;
    serializer.load = function(blockState, target) {
      if (target !== workspace || loading) return originalLoad.call(this, blockState, target);
      loading = true;
      try {
        for (const block of blockState.blocks) {
          Blockly.serialization.blocks.appendInternal(block, target, {recordUndo: Blockly.Events.getRecordUndo()});
        }
        // Small projects don't benefit from a separate style-read pass.
        if (workspace.getAllBlocks(false).length >= 1000) primeBlocklyTextWidths(workspace);
        Blockly.renderManagement.triggerQueuedRenders(workspace);
      } finally {
        loading = false;
      }
    };
  }
  Blockly.utils.dom.startTextWidthCache();
  try {
    Blockly.serialization.workspaces.load(state, workspace);
    Blockly.renderManagement.triggerQueuedRenders();
  } finally {
    if (useBatch) {
      if (ownLoad) Object.defineProperty(serializer, 'load', ownLoad);
      else delete (serializer as Partial<Blockly.serialization.blocks.BlockSerializer>).load;
    }
    Blockly.utils.dom.stopTextWidthCache();
    Blockly.Events.setGroup(group);
    Blockly.Events.setRecordUndo(recordUndo);
  }
}

export interface WorkspaceCodeEvent {
  type?: string;
  element?: string;
  oldParentId?: string;
  newParentId?: string;
  oldInputName?: string;
  newInputName?: string;
}

/**
 * Sample live Blockly/DOM state instead of retaining a drag flag which can go
 * stale after a cancelled gesture. WidgetDiv covers field/custom editors;
 * DropDownDiv covers menus/sliders; focused editable elements cover comments
 * and IME composition, including pauses between keystrokes.
 */
export function isBlocklyWorkspaceInteracting(workspace: Blockly.WorkspaceSvg): boolean {
  if ((workspace as any).currentGesture_ || workspace.isDragging()
    || Blockly.WidgetDiv.isVisible() || Blockly.DropDownDiv.isVisible()) return true;
  const active = workspace.getInjectionDiv()?.ownerDocument.activeElement;
  return !!active && (active.matches('input, textarea, select, [role="textbox"]')
    || (active as HTMLElement).isContentEditable === true);
}

/** Layout moves only affect code if they change top-level execution order. */
export class WorkspaceCodeChangeTracker {
  private topBlockOrder: string | null = null;

  affectsCode(event: WorkspaceCodeEvent | null | undefined, workspace: Blockly.Workspace): boolean {
    const type = event?.type;
    if (type && !['create', 'delete', 'change', 'move', 'var_create', 'var_delete', 'var_rename'].includes(type)) {
      return false;
    }
    if (type === 'change' && ['collapsed', 'inline'].includes(event?.element ?? '')) return false;
    const order = JSON.stringify(workspace.getTopBlocks(true).map(block => block.id));
    const layoutOnly = type === 'move'
      && event?.oldParentId === event?.newParentId
      && event?.oldInputName === event?.newInputName
      && this.topBlockOrder === order;
    this.topBlockOrder = order;
    return !layoutOnly;
  }
}
