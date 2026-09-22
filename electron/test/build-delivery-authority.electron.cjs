'use strict';
// Isolated windows, real IPC and supervised child processes. Artifact data is
// synthetic; this test does not claim SDK compilation or QEMU acceptance.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createBuildDeliveryAuthority } = require('../build-delivery-authority');
const { captureBuildSource } = require('../../child/scripts/build-source-capture');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-delivery-electron-')));
process.env.AILY_APPDATA_PATH = path.join(root, 'appdata');
process.env.AILY_CHILD_PATH = path.resolve(__dirname, '../../child');
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
const locks = require('../appdata-resource-lock'), cmd = require('../cmd');
const windows = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const until = Date.now() + 10000;
  while (Date.now() < until) { if (await predicate()) return; await delay(20); }
  throw new Error('Owned delivery fixture timed out.');
}
async function window() {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: false, contextIsolation: true,
    nodeIntegrationInSubFrames: true, preload: path.resolve(__dirname, 'fixtures/build-delivery-preload.cjs') } });
  windows.push(w); await w.loadURL('data:text/html,<title>Owned delivery check</title>'); return w;
}
const invoke = (w, channel, data) => w.webContents.executeJavaScript(`window.buildTest.invoke(${JSON.stringify(channel)},${JSON.stringify(data)})`);
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };

app.whenReady().then(async () => {
  let checks = 0;
  try {
    const main = await window(), foreign = await window(); let generation = 1, queryHook;
    const authority = createBuildDeliveryAuthority({ childRoot: path.resolve(__dirname, 'fixtures/build-delivery-child'),
      getOwner: () => ({ sender: main.webContents, generation }),
      querySource: async () => {
        if (queryHook) await queryHook();
        return { ok: true, source: await main.webContents.executeJavaScript('window.source') };
      } });
    locks.registerAppDataResourceLockHandlers(); cmd.registerCmdHandlers(undefined, { buildDeliveryAuthority: authority });
    ipcMain.handle('fixture-query', (event, request) => authority.query(event.sender, request));
    async function prepare(mode = 'blockly', outcome = 'normal') {
      const project = path.join(root, randomUUID());
      put(path.join(project, 'package.json'), { type: mode, entry: 'src/main.cpp' });
      put(path.join(project, 'node_modules/@aily-project/board-test/board.json'), {});
      put(path.join(project, 'node_modules/@aily-project/board-test/package.json'), {});
      const config = { currentProjectPath: project, boardModule: '@aily-project/board-test', code: 'void setup(){} void loop(){}', recordProjectDelivery: true, fixtureOutcome: outcome };
      if (mode === 'coder') put(path.join(project, 'sketch/src/main.cpp'), config.code);
      config.sourceCapture = captureBuildSource(config, mode === 'coder' ? undefined : { documentText: '{}', revision: 1, runtimeRevision: 1, pageId: 'main' });
      const request = put(path.join(project, `.temp/compile-request-${randomUUID()}.json`), config);
      const state = { projectPath: project, mode, activationId: randomUUID(), boardModule: config.boardModule,
        ...(mode === 'coder' ? { saved: true } : { workspace: config.sourceCapture.workspace }) };
      await main.webContents.executeJavaScript(`window.source=${JSON.stringify(state)}`);
      const lease = await invoke(main, 'appdata-resource-lock-acquire', { mode: 'read', requestId: randomUUID(), label: 'delivery fixture', timeoutMs: 5000 });
      assert.equal(lease.ok, true);
      const options = { command: process.execPath, args: [path.resolve(__dirname, 'fixtures/build-delivery-child/scripts/compile.js'), request],
        streamId: randomUUID(), buildWorkspace: project, buildDeliveryRequest: request, shellProfile: false,
        env: { ELECTRON_RUN_AS_NODE: '1' }, appDataResourceToken: lease.token };
      return { project, request, state, lease, options };
    }
    async function finish(f) {
      await main.webContents.executeJavaScript(`window.buildTest.watch(${JSON.stringify(f.options.streamId)})`);
      const result = await invoke(main, 'cmd-run', f.options); assert.equal(result.success, true, result.error);
      await invoke(main, 'appdata-resource-lock-release', { token: f.lease.token });
      await waitFor(() => !fs.existsSync(f.lease.lockPath));
      assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
      return result;
    }
    for (const mode of ['blockly', 'coder']) {
      const f = await prepare(mode), result = await finish(f);
      const current = await invoke(main, 'fixture-query', { projectPath: f.project, handle: result.buildDeliveryHandle });
      assert.equal(current.status, 'source-current', await main.webContents.executeJavaScript('window.buildTest.diagnostics()')); assert.equal(current.currentProjectAcceptance, false); checks++;
      await assert.rejects(invoke(foreign, 'fixture-query', { projectPath: f.project }), /main renderer/); checks++;
      await main.webContents.executeJavaScript(mode === 'coder' ? 'window.source.saved=false' : 'window.source.workspace.revision++');
      await assert.rejects(invoke(main, 'fixture-query', { projectPath: f.project }), /unsaved|workspace/); checks++;
    }
    for (const outcome of ['failed', 'no-message']) {
      const f = await prepare('blockly', outcome); await finish(f);
      assert.equal((await invoke(main, 'fixture-query', { projectPath: f.project })).status, 'failed'); checks++;
    }
    {
      const f = await prepare(); let resume, entered = false;
      queryHook = () => { entered = true; return new Promise(resolve => { resume = resolve; }); };
      const starting = invoke(main, 'cmd-run', f.options); await waitFor(() => entered);
      await invoke(main, 'appdata-resource-lock-release', { token: f.lease.token }); resume();
      const result = await starting; assert.equal(result.success, false); assert.match(result.error, /CANCELLED/);
      assert.equal(fs.existsSync(path.join(f.project, '.temp/fixture-pid')), false);
      assert.equal(fs.existsSync(f.lease.lockPath), false); queryHook = undefined; checks++;
    }
    {
      const f = await prepare('blockly', 'hold');
      const result = await invoke(main, 'cmd-run', f.options); assert.equal(result.success, true);
      await waitFor(() => fs.existsSync(path.join(f.project, '.temp/fixture-pid')));
      await invoke(main, 'appdata-resource-lock-release', { token: f.lease.token });
      assert.equal(await cmd.killCmdProcess(f.options.streamId), true);
      assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
      // OS tree termination may precede Node's queued close notification.
      await waitFor(async () => (await invoke(main, 'fixture-query', { projectPath: f.project })).status !== 'running');
      assert.equal((await invoke(main, 'fixture-query', { projectPath: f.project })).status, 'failed');
      assert.equal(fs.existsSync(f.lease.lockPath), false); checks++;
    }
    {
      const f = await prepare(); await finish(f); generation++;
      await assert.rejects(invoke(main, 'fixture-query', { projectPath: f.project }), /generation/); checks++;
    }
    {
      const f = await prepare();
      await main.webContents.executeJavaScript(`new Promise(resolve=>{const f=document.createElement('iframe');f.src='data:text/html,frame';f.onload=resolve;document.body.appendChild(f)})`);
      const frame = main.webContents.mainFrame.frames[0];
      const result = await frame.executeJavaScript(`window.buildTest.invoke('cmd-run',${JSON.stringify(f.options)})`);
      assert.equal(result.success, false); assert.match(result.error, /authority unavailable/);
      await invoke(main, 'appdata-resource-lock-release', { token: f.lease.token }); checks++;
    }
    assert.equal(cmd.getActiveCmdProcesses().length, 0);
    console.log(JSON.stringify({ outcome: 'passed', checks, root, hiddenElectron: true, firmwareCompiled: false }));
    for (const w of windows) if (!w.isDestroyed()) w.destroy(); locks.releaseAllAppDataResourceLocks(); app.exit(0);
  } catch (error) {
    console.error(error); await cmd.killAllCmdProcesses();
    for (const w of windows) if (!w.isDestroyed()) w.destroy(); locks.releaseAllAppDataResourceLocks(); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
