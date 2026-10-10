const {app, BrowserWindow} = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({width: 1440, height: 800, useContentSize: true, webPreferences: {backgroundThrottling: false}});
  win.loadURL(process.env.BLOCKLY_PERF_URL || 'http://127.0.0.1:8313/official.html?topology=stack');
});
app.on('window-all-closed', () => app.quit());
