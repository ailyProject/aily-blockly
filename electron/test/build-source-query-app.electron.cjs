'use strict';
// Load the actual development renderer/preload, but isolate all user data and
// block network. This verifies root DI/IPC initialization, not project opening.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const http = require('node:http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-source-query-app-'));
process.env.AILY_APPDATA_PATH = path.join(root, 'appdata');
process.env.AILY_PROJECT_PATH = path.join(root, 'projects');
process.env.AILY_CHILD_PATH = path.resolve(__dirname, '../../child');
process.env.AILY_SYSTEM_LANG = 'zh-CN';
fs.mkdirSync(process.env.AILY_APPDATA_PATH); fs.mkdirSync(process.env.AILY_PROJECT_PATH);
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = path.resolve(__dirname, '../../dist/aily-blockly/browser');
  const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(directory, `.${relative === '/' ? '/index.html' : relative}`);
    if (!filename.startsWith(directory + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
      response.writeHead(404); response.end(); return;
    }
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' })[path.extname(filename)] || 'application/octet-stream');
    fs.createReadStream(filename).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  ipcMain.handle('get-app-version', () => '0.9.99-test'); ipcMain.handle('get-renderer-generation', () => 1);
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: false, contextIsolation: true,
    preload: path.resolve(__dirname, '../preload.js') } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2 && errors.length < 12) errors.push(message); });
  window.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => done({ cancel: !details.url.startsWith(origin) }));
  try {
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`Actual app did not initialize the build source query listener: ${errors.join('\n')}`)); }, 15000);
      const poll = setInterval(() => window.webContents.send('build-source-query', {
        requestId: 'owned-app-query', rendererGeneration: 0, projectPath: path.join(root, 'unopened-project'),
      }), 200);
      ipcMain.on('build-source-query:response', (event, data) => {
        if (event.sender !== window.webContents || data.requestId !== 'owned-app-query') return;
        clearTimeout(timer); clearInterval(poll); resolve(data);
      });
    });
    await window.loadURL(origin);
    const reply = await response;
    assert.equal(reply.ok, false); assert.match(reply.message, /Project switched, reloaded, or is in transition/);
    console.log(JSON.stringify({ outcome: 'passed', actualRenderer: true, root, checks: 1 }));
    window.destroy(); server.close(); app.exit(0);
  } catch (error) { console.error(error); window.destroy(); server.close(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
