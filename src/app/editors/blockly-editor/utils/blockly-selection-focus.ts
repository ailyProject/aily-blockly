import * as Blockly from 'blockly/core';

/** Keep editor context while focus is in another pane, window or block field. */
export function shouldRetainBlocklySelection(workspace: Blockly.WorkspaceSvg): boolean {
  const focus = Blockly.getFocusManager();
  const tree = focus.getFocusedTree();
  return !tree || (tree === workspace && !Blockly.getSelected() &&
    focus.getFocusedNode() !== workspace.getRootFocusableNode());
}
