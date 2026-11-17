// Keep native Cocoa controls; Electron exposes their visibility only as a group.
function prepareConsentWindow(consent, owner, theme) {
  if (process.platform !== 'darwin') return { setTheme() {}, restore() {} };
  const native = require('./native/window-chrome.node');
  const setTheme = mode => {
    if (!consent.isDestroyed()) native.setCloseOnlyControls(consent.getNativeWindowHandle(), mode === 'dark');
  };
  setTheme(theme);
  const gate = native.beginConsentGate(owner.getNativeWindowHandle(), consent.getNativeWindowHandle());
  return { setTheme, restore() { native.endConsentGate(gate); } };
}

module.exports = { prepareConsentWindow };
