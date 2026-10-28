import * as Blockly from 'blockly/core';

/** Focus loss or a toolbox preview is not an explicit editor deselection. */
export function shouldRetainBlocklySelection(): boolean {
  const selected = Blockly.getSelected();
  return !selected || (selected instanceof Blockly.BlockSvg && selected.isInFlyout);
}

export interface BlocklySelectionChange {
  newElementId?: string;
  ailySelectionClear?: boolean;
}

/** Publish a selection edit even when the focused group node did not change. */
export function fireBlocklySelectionChange(workspace: Blockly.Workspace, selectedId: string | null): void {
  const event = new Blockly.Events.Selected(null, selectedId, workspace.id) as Blockly.Events.Selected & BlocklySelectionChange;
  // Do not let Blockly merge explicit selection edits with native blur events.
  event.group = Blockly.utils.idGenerator.genUid();
  event.ailySelectionClear = !selectedId;
  Blockly.Events.fire(event);
}
