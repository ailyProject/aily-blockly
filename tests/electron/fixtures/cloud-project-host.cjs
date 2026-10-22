const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourceRoot = process.env.AILY_CLOUD_HOST_SOURCE_ROOT;
const product = process.env.AILY_CLOUD_HOST_PRODUCT;
const { isProductProtocolUrl } = require(path.join(sourceRoot, 'electron/build-product'));
const { createCloudProjectOpenQueue } = require(path.join(sourceRoot, 'electron/cloud-project-protocol'));
const source = fs.readFileSync(path.join(sourceRoot, 'electron/main.js'), 'utf8');
const begin = source.indexOf('function protocolLogValue(');
const end = source.indexOf('// ipc handlers模块', begin);
const readyBegin = source.indexOf("ipcMain.on('renderer-ready',");
const readyEnd = source.indexOf('\nfunction registerPowerMonitorLifecycle()', readyBegin);
assert.ok(begin >= 0 && end > begin && readyBegin >= 0 && readyEnd > readyBegin, 'Production dispatch boundaries changed');
app.setPath('userData', process.env.AILY_CLOUD_HOST_PROFILE);
app.disableHardwareAcceleration();
const context = vm.createContext({ URL, console, createCloudProjectOpenQueue, ipcMain, global: {},
  getBuildProduct: () => product, isSupportedProtocolUrl: url => isProductProtocolUrl(product, url),
  mainWindow: null, rendererGeneration: 1, readyRendererGeneration: 0,
  rendererSystemSuspended: false, rendererScreenLocked: false, rendererCommandGate: { notify() {} },
});
context.isCurrentRendererGenerationReady = () => context.readyRendererGeneration === context.rendererGeneration && !!context.mainWindow;
context.isCurrentMainRenderer = sender => sender === context.mainWindow?.webContents;
vm.runInContext(source.slice(begin, end) + '\n' + source.slice(readyBegin, readyEnd), context, { filename: 'production-cloud-project-dispatch.js' });
const scheme = product === 'coder' ? 'acis' : 'abis';
const cold = 'b27dffb8-6d46-4c39-864c-d16f8b9d483a';
const apiOrigin = 'https://api.example';
context.handleProtocol(`${scheme}://project/open?cloudProject=${cold}&apiOrigin=${encodeURIComponent(apiOrigin)}`);
context.handleProtocol(`${scheme}://project/open?cloudProject=${cold}&apiOrigin=${encodeURIComponent(apiOrigin)}`);
const received = () => new Promise(resolve => ipcMain.once('test-cloud-received', (_event, request) => resolve(request)));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: !['data:', 'file:'].includes(url.protocol)
      && !(['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) });
  });
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  window.show = () => {}; window.focus = () => {};
  context.mainWindow = window;
  try {
    await window.loadURL('data:text/html,<title>Isolated cloud project host test</title>');
    await window.webContents.executeJavaScript(`
      window.requests = [];
      const ipc = require('electron').ipcRenderer;
      ipc.on('open-cloud-project', (_event, request) => { window.requests.push(request); ipc.send('test-cloud-received', request); });
      ipc.send('renderer-ready', { generation: 0 });
    `);
    assert.equal(context.readyRendererGeneration, 0);
    const coldReceived = received();
    await window.webContents.executeJavaScript("require('electron').ipcRenderer.send('renderer-ready', { generation: 1 })");
    assert.deepEqual(await coldReceived, { cloudProject: cold, apiOrigin });
    const hotReceived = received();
    context.handleProtocol(`${scheme}://project/open?cloudProject=12345`);
    assert.deepEqual(await hotReceived, { cloudProject: '12345' });
    context.handleProtocol(`${scheme}://project/open?cloudProject=${cold}&token=forbidden`);
    context.handleProtocol(`${product === 'coder' ? 'abis' : 'acis'}://project/open?cloudProject=${cold}`);
    assert.deepEqual(await window.webContents.executeJavaScript('window.requests'), [{ cloudProject: cold, apiOrigin }, { cloudProject: '12345' }]);
    process.stdout.write(`CLOUD_PROJECT_HOST_OK ${product}\n`);
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); window.destroy(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
