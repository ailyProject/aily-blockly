import * as Blockly from 'blockly';

let variableComparatorInstalled = false;

/** Keep Blockly's case-insensitive locale ordering without constructing a
 * collator for every comparison in every variable dropdown. */
export function installBlocklyVariableComparator(): void {
  if (variableComparatorInstalled) return;
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
  Blockly.VariableModel.compareByName = (left, right) => collator.compare(left.name, right.name);
  variableComparatorInstalled = true;
}

/** Blockly queues renders during JSON loading, but closes its text cache before
 * the animation frame runs. Flush that batch while the cache is still active;
 * do not render the entire workspace a second time after loading. */
export function loadBlocklyWorkspace(workspace: Blockly.WorkspaceSvg, state: object): void {
  Blockly.utils.dom.startTextWidthCache();
  try {
    Blockly.serialization.workspaces.load(state, workspace);
    Blockly.renderManagement.triggerQueuedRenders();
  } finally {
    Blockly.utils.dom.stopTextWidthCache();
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
