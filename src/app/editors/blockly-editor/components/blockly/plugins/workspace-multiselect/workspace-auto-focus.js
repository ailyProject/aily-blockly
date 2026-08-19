/**
 * Decides whether entering the Blockly workspace should move keyboard focus to
 * it. Focus inside a child app is represented by the iframe element in the
 * host document, so it must be preserved like focus in a host text input.
 *
 * @param {boolean|undefined} workspaceAutoFocus Whether hover autofocus is on.
 * @param {Element|null} activeElement The host document's active element.
 * @param {Element|null} workspaceFocusTarget The Blockly focus target.
 * @returns {boolean} Whether Blockly should take focus.
 */
export function shouldAutoFocusWorkspace(
    workspaceAutoFocus,
    activeElement,
    workspaceFocusTarget) {
  if (workspaceAutoFocus === false || activeElement === workspaceFocusTarget) {
    return false;
  }

  const activeTagName = activeElement?.nodeName?.toLowerCase();
  return activeTagName !== 'input' &&
      activeTagName !== 'textarea' &&
      activeTagName !== 'iframe';
}
