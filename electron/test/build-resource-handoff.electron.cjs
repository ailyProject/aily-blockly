'use strict';
// Owned hidden windows and real Node descendants; never reuses user projects.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-build-resource-electron-'));
process.env.AILY_APPDATA_PATH = path.join(root, 'appdata');
process.env.AILY_CHILD_PATH = path.resolve(__dirname, '../../child');
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
const locks = require('../appdata-resource-lock');
const cmd = require('../cmd');
const npm = require('../npm');
const cleanup = require('../appdata-resource-cleanup');
const windows = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  throw new Error('Timed out waiting for owned IPC/process fixture');
}
async function window() {
  const w = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, sandbox: false,
  } }); windows.push(w);
  await w.loadURL('data:text/html,<title>Owned resource handoff check</title>'); return w;
}
const invoke = (w, channel, data) => w.webContents.executeJavaScript(
  `window.electronAPI.ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(data)})`);
const acquire = (w, mode, requestId) => invoke(w, 'appdata-resource-lock-acquire', { mode, requestId, label: requestId, timeoutMs: 5000 });
const release = (w, token) => invoke(w, 'appdata-resource-lock-release', { token });

app.whenReady().then(async () => {
  locks.registerAppDataResourceLockHandlers(); cmd.registerCmdHandlers(); npm.registerNpmHandlers();
  cleanup.registerAppDataResourceCleanupHandlers();
  let checks = 0;
  try {
    const a = await window(), b = await window();
    const project = path.join(root, 'project'); fs.mkdirSync(project);
    const reader = await acquire(a, 'read', 'build'); assert.equal(reader.commandHandoff, true);
    assert.equal((await release(b, reader.token)).ok, false); checks++;
    const script = `const fs=require('fs'),cp=require('child_process');
      const owner=require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'compile');
      const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
      fs.writeFileSync(process.argv[3],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
    const pidsFile = path.join(root, 'pids.json');
    const options = { command: process.execPath, args: ['-e', script,
      path.join(process.env.AILY_CHILD_PATH, 'scripts/build-workspace-lease.js'), project, pidsFile],
      streamId: 'resource-build', shellProfile: false, env: { ELECTRON_RUN_AS_NODE: '1' },
      buildWorkspace: project, appDataResourceToken: reader.token };
    assert.equal((await invoke(b, 'cmd-run', options)).success, false); checks++;
    assert.equal((await invoke(a, 'cmd-run', options)).success, true);
    await waitFor(() => fs.existsSync(pidsFile)); checks++;
    assert.equal((await release(a, reader.token)).retainedByCommand, true);
    a.destroy(); assert.equal(fs.existsSync(reader.lockPath), true); checks++;
    await b.webContents.executeJavaScript(`window.writerResult=null; void window.electronAPI.ipcRenderer.invoke(
      'appdata-resource-lock-acquire',{mode:'write',requestId:'install',label:'install',timeoutMs:5000}).then(r=>window.writerResult=r);`);
    await delay(650);
    assert.equal(await b.webContents.executeJavaScript('window.writerResult'), null); checks++;
    assert.equal(await cmd.killCmdProcess('resource-build'), true);
    for (const pid of JSON.parse(fs.readFileSync(pidsFile))) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(fs.existsSync(reader.lockPath), false); checks++;
    await waitFor(() => b.webContents.executeJavaScript('window.writerResult!==null'));
    const writer = await b.webContents.executeJavaScript('window.writerResult'); assert.equal(writer.ok, true);
    const c = await window();
    const pending = acquire(c, 'read', 'queued');
    await delay(50); await invoke(c, 'appdata-resource-lock-cancel', { requestId: 'queued' });
    assert.equal((await pending).error, 'APPDATA_RESOURCE_LOCK_CANCELLED'); checks++;
    await release(b, writer.token);
    const normal = await acquire(c, 'read', 'normal');
    const normalScript = `const o=require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'compile');setTimeout(()=>{o.release();process.exit(0)},100);`;
    assert.equal((await invoke(c, 'cmd-run', { ...options, streamId: 'normal-build', appDataResourceToken: normal.token,
      args: ['-e', normalScript, options.args[2], project] })).success, true);
    await release(c, normal.token);
    await waitFor(() => !fs.existsSync(normal.lockPath)); checks++;
    const failed = await acquire(c, 'read', 'spawn-failure');
    await invoke(c, 'cmd-run', { ...options, command: path.join(root, 'missing-node.exe'), args: [], streamId: 'spawn-failure', appDataResourceToken: failed.token });
    await release(c, failed.token);
    await waitFor(() => !fs.existsSync(failed.lockPath)); checks++;
    const node = process.env.AILY_TEST_NODE_EXE;
    assert.ok(node && fs.existsSync(node), 'Pass a real Node executable in AILY_TEST_NODE_EXE');
    const installScript = path.resolve(__dirname, 'fixtures/install-resource-process.cjs');
    for (const transport of ['npm', 'cmd']) for (const end of ['destroy', 'reload']) {
      const owner = await window(), lease = await acquire(owner, 'write', `${transport}-install`);
      assert.equal(lease.writerCommandHandoff, true);
      const pids = path.join(root, `${transport}-${end}-install-pids.json`);
      const request = transport === 'npm'
        ? { cmd: `"${node}" "${installScript}" hold "${pids}"`, appDataResourceToken: lease.token }
        : { command: node, args: [installScript, 'hold', pids], shellProfile: false,
            streamId: 'install-writer', appDataResourceMode: 'write', appDataResourceToken: lease.token };
      if (transport === 'npm') await assert.rejects(invoke(b, 'npm-run', request), /NOT_OWNED/);
      else assert.equal((await invoke(b, 'cmd-run', request)).success, false);
      checks++;
      const running = invoke(owner, `${transport}-run`, request).catch(() => undefined);
      await waitFor(() => fs.existsSync(pids));
      assert.equal((await release(owner, lease.token)).retainedByCommand, true);
      if (end === 'destroy') owner.destroy();
      else {
        await owner.loadURL('data:text/html,<title>Reloaded resource owner</title>');
        assert.throws(() => locks.retainAppDataResourceLock(lease.token, owner.webContents.id, 'write'), /NOT_OWNED/);
      }
      assert.equal(fs.existsSync(lease.lockPath), true); checks++;
      let acquired = false;
      const waiting = acquire(b, 'read', `${transport}-waiting-build`).then(r => { acquired = true; return r; });
      await delay(650); assert.equal(acquired, false); checks++;
      assert.equal(transport === 'npm' ? await npm.killAllNpmProcesses() : await cmd.killCmdProcess('install-writer'), true);
      for (const pid of JSON.parse(fs.readFileSync(pids))) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await waitFor(() => !fs.existsSync(lease.lockPath)); checks++;
      const read = await waiting; assert.equal(read.ok, true); await release(b, read.token);
      // Destroyed renderer invocations may never resolve in Electron; they do
      // not own process cleanup. The main inventory above is authoritative.
      void running;
    }
    for (const mode of ['normal', 'failure']) {
      const lease = await acquire(c, 'write', `npm-${mode}`);
      const running = invoke(c, 'npm-run', { cmd: `"${node}" "${installScript}" ${mode}`, appDataResourceToken: lease.token });
      const settled = mode === 'failure' ? assert.rejects(running, /7/) : running;
      await waitFor(() => npm.getActiveNpmProcesses().length === 1);
      assert.equal((await release(c, lease.token)).retainedByCommand, true);
      await settled; await waitFor(() => !fs.existsSync(lease.lockPath)); checks++;
    }
    const wrongMode = await acquire(c, 'read', 'not-an-installer');
    await assert.rejects(invoke(c, 'npm-run', { cmd: 'must-not-spawn', appDataResourceToken: wrongMode.token }), /NOT_OWNED/);
    await release(c, wrongMode.token); checks++;
    const cleanupWriter = await acquire(c, 'write', 'cleanup');
    const resource = path.join(process.env.AILY_APPDATA_PATH, 'sdk/owned-fixture'); fs.mkdirSync(resource, { recursive: true });
    await assert.rejects(invoke(b, 'appdata-resource-remove', { token: cleanupWriter.token, target: resource }), /NOT_OWNED/);
    await assert.rejects(invoke(c, 'appdata-resource-remove', { token: cleanupWriter.token, target: root }), /PATH_UNSAFE/);
    assert.equal((await invoke(c, 'appdata-resource-remove', { token: cleanupWriter.token, target: resource })).ok, true);
    assert.equal(fs.existsSync(resource), false); await release(c, cleanupWriter.token); checks++;
    assert.equal(cmd.getActiveCmdProcesses().length, 0);
    assert.equal(npm.getActiveNpmProcesses().length, 0);
    console.log(JSON.stringify({ outcome: 'passed', root, checks, hiddenElectron: true }));
    for (const w of windows) if (!w.isDestroyed()) w.destroy();
    locks.releaseAllAppDataResourceLocks(); app.exit(0);
  } catch (error) {
    console.error(error); await cmd.killAllCmdProcesses(); await npm.killAllNpmProcesses();
    for (const w of windows) if (!w.isDestroyed()) w.destroy();
    locks.releaseAllAppDataResourceLocks(); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
