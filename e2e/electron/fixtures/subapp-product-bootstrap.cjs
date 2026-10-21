'use strict';
// Test process only. Load the actual production main/preload/renderer without
// changing OS protocol registrations or raising windows over the user's app.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const childProcess = require('node:child_process');
if (process.env.AILY_E2E !== '1' || !process.env.AILY_PRODUCT_ACCEPTANCE_ROOT) {
  throw new Error('This bootstrap requires an isolated product acceptance root');
}
app.setAsDefaultProtocolClient = () => false;
app.removeAsDefaultProtocolClient = () => false;
for (const method of ['show', 'showInactive', 'focus', 'restore']) BrowserWindow.prototype[method] = function () {};
app.on('browser-window-created', (_event, window) => {
  window.hide();
  // Hidden acceptance windows must still paint live Angular/iframe progress.
  // Otherwise Chromium pauses rAF until a later screenshot/visibility event.
  window.webContents.setBackgroundThrottling(false);
});
const spawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = spawn.apply(this, args);
  child.stdout?.on('data', data => process.stdout.write(`[fixture-child:${child.pid}] ${data}`));
  child.stderr?.on('data', data => process.stderr.write(`[fixture-child:${child.pid}] ${data}`));
  return child;
};
require(path.join(__dirname, 'main.js'));
