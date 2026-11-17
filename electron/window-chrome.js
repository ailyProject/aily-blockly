// Keep native Cocoa controls; Electron exposes their visibility only as a group.
function prepareConsentWindow(consent, owner, theme) {
  if (process.platform !== 'darwin') return { restore() {}, setTheme() {} };
  const native = require('./native/window-chrome.node');
  const setTheme = mode => {
    if (!consent.isDestroyed()) native.setCloseOnlyControls(consent.getNativeWindowHandle(), mode === 'dark');
  };
  setTheme(theme);
  const ignoredMouse = native.getIgnoresMouseEvents(owner.getNativeWindowHandle());
  const focusable = owner.isFocusable();
  owner.setIgnoreMouseEvents(true);
  owner.setFocusable(false);
  let active = true;
  return { setTheme, restore() {
    if (!active) return;
    active = false;
    if (!owner.isDestroyed()) {
      owner.setIgnoreMouseEvents(ignoredMouse);
      owner.setFocusable(focusable);
    }
  } };
}

module.exports = { prepareConsentWindow };
