'use strict';
// Standalone hidden-window smoke test. No user project or running application
// is reused. Launch with Electron, not Node/ELECTRON_RUN_AS_NODE.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireBuildWorkspace } = require('../../child/scripts/build-workspace-lease');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-publication-electron-'));
const project = path.join(root, 'project');
fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'package.json'), '{"type":"blockly","keep":true}');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
process.env.AILY_CHILD_PATH = path.resolve(__dirname, '../../child');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false,
  } });
  let preloadError;
  window.webContents.on('preload-error', (_event, _filename, error) => { preloadError = error; });
  try {
    await window.loadURL('data:text/html,<meta charset="utf-8"><title>Owned publication smoke</title>');
    assert.ifError(preloadError);
    const call = async (name, payload) => {
      // executeJavaScript intentionally masks uncaught renderer error details;
      // inspect the message in the same context as the actual Angular caller.
      const result = await window.webContents.executeJavaScript(
        `(() => { try { return { ok: true, value: window.electronAPI.builder.${name}(${JSON.stringify(project)}, ${JSON.stringify(payload)}) }; }
          catch (error) { return { ok: false, error: error.message }; } })()`);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    };
    const request = { artifacts: [{ fileName: 'variables_smoke-1234abcd.h', content: 'const int smoke = 1;', sourceTag: 'smoke' }], sketchCode: 'void setup() {}' };
    assert.equal((await call('publishArduinoGeneratedCode', request)).changed, true);
    assert.equal(fs.readFileSync(path.join(project, '.temp/sketch/sketch.ino'), 'utf8'), request.sketchCode);
    assert.equal((await call('publishArduinoGeneratedCode', request)).changed, false);
    const owner = acquireBuildWorkspace(project, 'compile');
    try {
      await assert.rejects(call('publishArduinoGeneratedCode', { artifacts: [], sketchCode: 'wrong' }), /BUILD_WORKSPACE_BUSY/);
      await assert.rejects(call('patchBuildMetadata', { codeHash: 'a'.repeat(64) }), /BUILD_WORKSPACE_BUSY/);
    } finally { owner.release(); }
    const manifest = await call('patchBuildMetadata', { codeHash: 'b'.repeat(64) });
    assert.equal(manifest.keep, true); assert.equal(manifest.codeHash, 'b'.repeat(64));
    assert.equal(fs.existsSync(path.join(project, '.build/aily-workspace.lock')), false);
    const boardModule = '@aily-project/board-test';
    const board = path.join(project, 'node_modules', boardModule);
    fs.mkdirSync(board, { recursive: true });
    for (const name of ['board.json', 'package.json']) fs.writeFileSync(path.join(board, name), '{}');
    const source = await window.webContents.executeJavaScript(
      `window.electronAPI.builder.captureBuildSource(${JSON.stringify({ currentProjectPath: project, boardModule, code: request.sketchCode })},
        ${JSON.stringify({ documentText: '{"blocks":[]}', revision: 7, runtimeRevision: 2, pageId: 'main' })})`);
    assert.equal(source.scope, 'captured-build-source'); assert.equal(source.workspace.revision, 7);
    assert.equal(source.generatedHeaderCount, 1);
    assert.equal(source.sourceSha256, require('node:crypto').createHash('sha256').update(request.sketchCode).digest('hex'));
    console.log(JSON.stringify({ outcome: 'passed', project, checks: 8, hiddenElectron: true }));
    window.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); window.destroy(); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
