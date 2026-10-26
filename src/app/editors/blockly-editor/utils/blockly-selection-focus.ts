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
