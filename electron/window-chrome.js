// Keep native Cocoa controls; Electron exposes their visibility only as a group.
function prepareConsentWindow(consent, theme) {
  if (process.platform !== 'darwin') return { setTheme() {} };
  const native = require('./native/window-chrome.node');
  const setTheme = mode => {
    if (!consent.isDestroyed()) native.setCloseOnlyControls(consent.getNativeWindowHandle(), mode === 'dark');
  };
  setTheme(theme);
  return { setTheme };
}

module.exports = { prepareConsentWindow };
