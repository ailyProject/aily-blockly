'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const trace = (stage, details = {}) => fs.appendFileSync(path.join(process.resourcesPath, 'probe-trace.log'), JSON.stringify({ stage, pid: process.pid, ...details }) + '\n');
process.on('uncaughtException', error => { trace('uncaught', { error: error.message }); console.error(error); app.exit(1); });
trace('main-before-ready', { packaged: app.isPackaged, defaultApp: process.defaultApp, resources: process.resourcesPath });
const config = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'probe.json'), 'utf8'));
assert.equal(app.isPackaged, true);
for (const name of ['AILY_CHILD_PATH', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) assert.equal(process.env[name], undefined, name);
const profile = path.join(process.resourcesPath, 'probe-profile'); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.commandLine.appendSwitch('lang', 'en-US');
app.whenReady().then(async () => {
  trace('app-ready');
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: false, contextIsolation: true,
    nodeIntegration: false, preload: path.join(__dirname, 'electron/generated-source-packaged-preload.cjs') } });
  let preloadError;
  window.webContents.on('preload-error', (_event, _filename, error) => { preloadError = error; trace('preload-error', { error: error.message }); });
  window.webContents.on('render-process-gone', (_event, details) => trace('renderer-gone', { reason: details.reason, exitCode: details.exitCode }));
  window.webContents.on('console-message', (_event, _level, message) => trace('renderer-console', { message }));
  try {
    await window.loadURL('data:text/html,<meta charset="utf-8"><title>Owned source archive probe</title>');
    trace('url-loaded');
    assert.ifError(preloadError);
    assert.equal(await window.webContents.executeJavaScript('window.publicationProbe.version'), 1);
    const request = { artifacts: [], sketchCode: 'void setup() {}\nvoid loop() {}\n', preserveSuperseded: true };
    const result = await window.webContents.executeJavaScript(`window.publicationProbe.publish(${JSON.stringify(config.project)}, ${JSON.stringify(request)})`);
    trace('publication-returned', { ok: result.ok, mismatch: config.expectMismatch, error: result.error });
    if (config.expectMismatch) {
      assert.equal(result.ok, false); assert.match(result.error, /restart the host/);
      assert.equal(fs.readFileSync(path.join(config.project, '.temp/sketch/sketch.ino'), 'utf8'), config.original);
    } else {
      assert.equal(result.ok, true, result.error); assert.equal(result.value.changed, true);
      const receipt = result.value.sourceArchive, filename = path.join(config.project, receipt.manifest);
      const manifest = fs.readFileSync(filename);
      assert.equal(`sha256:${createHash('sha256').update(manifest).digest('hex')}`, receipt.hash);
      const file = JSON.parse(manifest).files.find(file => file.path === '.temp/sketch/sketch.ino');
      const archived = fs.readFileSync(path.join(path.dirname(filename), file.archivedPath));
      assert.equal(archived.toString('utf8'), config.original);
      assert.equal(`sha256:${createHash('sha256').update(archived).digest('hex')}`, file.hash);
      assert.equal(fs.readFileSync(path.join(config.project, '.temp/sketch/sketch.ino'), 'utf8'), request.sketchCode);
    }
    assert.equal(fs.existsSync(path.join(config.project, '.build/aily-workspace.lock')), false);
    console.log(`GENERATED_SOURCE_ARCHIVE_PACKAGED_OK ${config.expectMismatch ? 'old-child-rejected' : 'preserved'}`);
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); window.destroy(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
