const path = require('node:path');
const { execFile } = require('node:child_process');

// Focus is separate from callback delivery: activating an existing application
// must never open another URL or tab.
function createBrowserReturn({ platform = process.platform, native, run = execFile, resourcesPath = process.resourcesPath,
  packaged = process.versions.electron ? require('electron').app.isPackaged : false } = {}) {
  if (platform === 'darwin') {
    native ||= require('./native/window-chrome.node');
    const tracker = native.beginBrowserTracking();
    return {
      capture: () => native.captureBrowser(tracker),
      restore: target => target ? native.restoreBrowser(target) : false,
      close: () => native.endBrowserTracking(tracker),
    };
  }
  if (platform === 'win32') {
    const script = packaged ? path.join(resourcesPath, 'app.asar.unpacked/electron/native/browser-return.ps1')
      : path.join(__dirname, 'native/browser-return.ps1');
    const invoke = args => new Promise(resolve => {
      run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
        { windowsHide: true, timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
          try { resolve(error ? null : JSON.parse(stdout.trim())); } catch { resolve(null); }
        });
    });
    return {
      capture: () => invoke(['-Mode', 'capture']),
      restore: target => target && /^\d+$/.test(target.handle) && Number.isSafeInteger(target.pid) && target.pid > 0
        ? invoke(['-Mode', 'restore', '-Handle', target.handle, '-ProcessId', String(target.pid), '-OwnerId', String(process.pid)]) : false,
      close() {},
    };
  }
  return { capture: () => null, restore: () => false, close() {} };
}

module.exports = { createBrowserReturn };
