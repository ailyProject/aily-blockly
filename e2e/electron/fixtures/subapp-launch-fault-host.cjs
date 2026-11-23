'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow } = require('electron');

const repo = path.resolve(__dirname, '../../..');
const resultRoot = path.join(repo, 'e2e', 'test-results', 'subapp-launch-faults');
const directory = process.env.AILY_LAUNCH_FAULT_DIRECTORY;
const appdata = process.env.AILY_LAUNCH_FAULT_STORE;
for (const location of [directory, appdata]) {
  if (!location || !path.resolve(location).startsWith(resultRoot + path.sep)) throw new Error('Isolated test path required');
  fs.mkdirSync(location, { recursive: true });
}
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
process.env.AILY_APPDATA_PATH = appdata;
process.env.AILY_NPM_PREFIX = path.join(appdata, 'npm-global');
process.env.AILY_CHILD_PATH = path.join(repo, 'child');
delete process.env.AILY_CODER_BUNDLE_TARBALL;

const cmd = require('../../../electron/cmd');
const windows = require('../../../electron/window');
const { acquireInstallLock } = require('../../../electron/subapp-install-lock');
const { registerSubappManagerHandlers } = require('../../../electron/subapp-manager');
const { selectionLockPath } = require('../../../electron/subapp-version-store');
const { npmTarball } = require('../../../tests/electron/fixtures/npm-tarball-fixture');
const ID = 'aily-chat', OTHER = 'launch-fixture';
const startupTimeoutMs = 200;
const installRoot = path.join(process.env.AILY_NPM_PREFIX, 'app');
const legacySelectionLock = path.join(installRoot, 'store', '.locks');
const page = path.join(directory, 'index.html');
fs.writeFileSync(page, '<!doctype html><title>Native subapp launch fixture</title>');
const runtime = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [mode, marker] = process.argv.slice(2);
if (mode === 'exit') process.exit(23);
const resistsTermination = mode === 'resistant-tree';
if (resistsTermination) process.on('SIGTERM', () => {});
const leaf = mode === 'tree' || resistsTermination
  ? spawn(process.execPath, ['-e', (resistsTermination ? "process.on('SIGTERM', () => {});" : '')
    + 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  : null;
fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, leaf: leaf?.pid }));
setInterval(() => {}, 1000);
`;
const packageName = id => `@aily-project/subapp-${id}`;
const legacy = id => path.join(installRoot, 'node_modules', ...packageName(id).split('/'));
const packageSelectionLock = id => selectionLockPath(installRoot, { id, package: packageName(id) });
function files(id, version) {
  return {
    'package.json': JSON.stringify({
      name: packageName(id), version, main: 'index.js',
      aily: { uiIndex: 'ui/index.html' },
      ailySubapp: { id, runtime: { startupTimeoutMs } },
      ailyPortable: { version: 1, format: 'js' },
    }),
    'index.js': runtime,
    'ui/index.html': '<!doctype html><title>Fixture</title>',
  };
}
function seed() {
  for (const id of [ID, OTHER]) {
    for (const [name, content] of Object.entries(files(id, '1.0.0'))) {
      const destination = path.join(legacy(id), name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
  }
}
const releases = Object.fromEntries([ID, OTHER].map(id => [id, '1.0.0']));
const archives = new Map(Object.keys(releases).map(id => {
  const archive = npmTarball(files(id, '1.1.0'));
  return [`/${id}.tgz`, { archive, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') }];
}));
const server = http.createServer((request, response) => {
  const asset = archives.get(request.url);
  if (asset) { response.end(asset.archive); return; }
  response.end(JSON.stringify(Object.fromEntries(Object.entries(releases).map(([id, version]) => {
    const tarball = `/${id}.tgz`;
    return [id, { id, package: packageName(id), version, titleKey: id, namespace: id,
      app: { enabled: true },
      ...(version === '1.1.0' ? { dist: { tarball: baseUrl() + tarball, integrity: archives.get(tarball).integrity } } : {}),
    }];
  }))));
});
const baseUrl = () => `http://127.0.0.1:${server.address().port}`;

function bounded(operation, milliseconds, message) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

async function until(probe, message, milliseconds = 8000) {
  const deadline = performance.now() + milliseconds;
  do {
    const value = probe();
    if (value) return value;
    await delay(25);
  } while (performance.now() < deadline);
  throw new Error(message);
}

let rendererIndex = 0;
async function open() {
  const owner = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(repo, 'electron', 'preload.js'),
    sandbox: false, contextIsolation: true, backgroundThrottling: false,
    partition: `launch-fault-window-${++rendererIndex}`,
  } });
  await owner.loadFile(page);
  return owner;
}

async function invoke(owner, api, method, ...args) {
  const reply = await owner.webContents.executeJavaScript(`(async () => {
    try { return { result: await window.electronAPI[${JSON.stringify(api)}][${JSON.stringify(method)}](...${JSON.stringify(args)}) }; }
    catch (error) { return { error: String(error.message || error) }; }
  })()`);
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

const prepare = (owner, id = ID) => invoke(owner, 'subapps', 'prepareLaunch', { id, deferPreparedUpdate: true });
const finish = (owner, reservation) => invoke(owner, 'subapps', 'finishLaunch', reservation.token);
const marker = stream => path.join(directory, `${stream}.json`);
function command(reservation, stream, mode = 'wait') {
  const { config, token } = reservation;
  return {
    command: 'node', shellProfile: false, streamId: stream,
    cwd: config.packagePath, args: [path.join(config.packagePath, config.entry), mode, marker(stream)],
    env: { AILY_CHILD_TOOL_ID: config.id }, subappLaunchToken: token,
  };
}
const run = (owner, reservation, stream, mode) => invoke(owner, 'cmd', 'run', command(reservation, stream, mode));
const gone = stream => until(() => !cmd.getCmdProcess(stream), `Leaked command ${stream}`);
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
async function started(owner, reservation, stream, mode) {
  const result = await run(owner, reservation, stream, mode);
  assert.equal(result.success, true, JSON.stringify(result));
  const runtime = await until(() => {
    try { return JSON.parse(fs.readFileSync(marker(stream), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }, `Runtime did not start for ${stream}`);
  assert.ok(pidAlive(runtime.pid));
  return runtime;
}
function register(owner, reservation, stream, pid, leaseId = stream) {
  return invoke(owner, 'childToolSession', 'register', {
    toolId: reservation.config.id, streamId: stream, leaseId, subappLaunchToken: reservation.token,
    hostInfo: { pid, packagePath: reservation.config.packagePath, runtimeConfig: reservation.config },
  });
}

async function runMatrix(first, other) {
  const scenarios = [];
  const record = async (name, execute) => {
    const start = performance.now();
    const elapsedMs = () => Math.round(performance.now() - start);
    try { await execute(); scenarios.push({ name, ok: true, ms: elapsedMs() }); }
    catch (error) { scenarios.push({ name, ok: false, ms: elapsedMs(), error: error.stack }); throw error; }
    finally { fs.writeFileSync(path.join(directory, 'scenarios.json'), JSON.stringify(scenarios, null, 2)); }
  };
  const retry = async (id = ID) => {
    const next = await bounded(prepare(other, id), 3000, `Same tool still blocked after a completed failure: ${id}`);
    await finish(other, next);
  };

  await record('child exits with an error before readiness while the renderer stays live', async () => {
    const reservation = await prepare(first);
    assert.equal((await run(first, reservation, 'early-exit', 'exit')).success, true);
    await gone('early-exit');
    await retry();
    await assert.rejects(register(first, reservation, 'early-exit', 0), /SUBAPP_LAUNCH_EXPIRED/);
  });

  await record('a removed entry invalidates the selection before child spawn and retry works', async () => {
    const reservation = await prepare(first);
    const entry = path.join(reservation.config.packagePath, reservation.config.entry);
    fs.unlinkSync(entry);
    try {
      const result = await run(first, reservation, 'missing-entry');
      assert.equal(result.success, false);
      assert.equal(result.code, 'SUBAPP_LAUNCH_CHANGED');
      await gone('missing-entry');
    } finally { fs.writeFileSync(entry, runtime); }
    await retry();
  });

  await record('missing working directory aborts spawn even when no child exit event is emitted', async () => {
    const reservation = await prepare(first);
    const cwd = reservation.config.packagePath;
    const moved = cwd + '-fixture';
    fs.renameSync(cwd, moved);
    try {
      const result = await run(first, reservation, 'invalid-cwd');
      assert.equal(result.success, false);
      assert.equal(result.code, 'SUBAPP_LAUNCH_CHANGED');
      await gone('invalid-cwd');
      assert.equal(fs.existsSync(marker('invalid-cwd')), false);
    } finally { fs.renameSync(moved, cwd); }
    await retry();
  });

  await record('explicitly terminated child releases startup admission with the owner still connected', async () => {
    const reservation = await prepare(first);
    const process = await started(first, reservation, 'external-stop');
    assert.equal((await invoke(first, 'cmd', 'kill', 'external-stop')).success, true);
    await gone('external-stop');
    assert.equal(pidAlive(process.pid), false);
    await retry();
  });

  await record('idle launch selection stays valid past the old timeout and rejects foreign commands', async () => {
    const reservation = await prepare(first);
    const foreign = await run(other, reservation, 'foreign');
    assert.match(foreign.error, /SUBAPP_LAUNCH_EXPIRED/);
    assert.equal(cmd.getCmdProcess('foreign'), undefined);
    const next = await bounded(prepare(other, OTHER), 3000, 'An undispatched launch blocked another tool');
    await finish(other, next);
    await delay(20500);
    const runtime = await started(first, reservation, 'idle-selection');
    assert.equal((await register(first, reservation, 'idle-selection', runtime.pid)).success, true);
    assert.equal((await invoke(first, 'childToolSession', 'stop', ID)).success, true);
    await gone('idle-selection');
  });

  await record('unready runtime expires, its process tree exits and another runtime stays live', async () => {
    const reservation = await prepare(first);
    const slow = await started(first, reservation, 'unready-tree', 'resistant-tree');
    assert.ok(pidAlive(slow.leaf));
    const unaffected = await bounded(prepare(other, OTHER), 3000, 'Different tool blocked by a running startup');
    const healthy = await started(other, unaffected, 'unaffected');
    assert.equal((await register(other, unaffected, 'unaffected', healthy.pid)).success, true);
    await finish(other, unaffected);
    await until(() => !pidAlive(slow.pid) && !pidAlive(slow.leaf), 'Timed-out runtime left a live descendant', 40000);
    await gone('unready-tree');
    assert.ok(pidAlive(healthy.pid));
    await assert.rejects(register(first, reservation, 'unready-tree', slow.pid), /SUBAPP_LAUNCH_EXPIRED/);
    await retry();
    assert.equal((await invoke(other, 'childToolSession', 'stop', OTHER)).success, true);
    await gone('unaffected');
  });

  await record('renderer reload invalidates a selected token before it can spawn', async () => {
    const reservation = await prepare(first);
    const loaded = once(first.webContents, 'did-finish-load');
    first.reload();
    await loaded;
    assert.match((await run(first, reservation, 'after-reload')).error, /SUBAPP_LAUNCH_EXPIRED/);
    assert.equal(cmd.getCmdProcess('after-reload'), undefined);
    await retry();
  });

  await record('a later window supersedes an unused same-tool selection and navigation cancels its replacement', async () => {
    const reservation = await prepare(first);
    const owner = await open();
    try {
      const next = await bounded(prepare(owner), 3000, 'An unused launch prevented a later same-tool request');
      assert.match((await run(first, reservation, 'superseded')).error, /SUBAPP_LAUNCH_EXPIRED/);
      const loaded = once(owner.webContents, 'did-finish-load');
      owner.reload();
      await loaded;
      assert.match((await run(owner, next, 'superseded-replacement-reloaded')).error, /SUBAPP_LAUNCH_EXPIRED/);
      assert.equal(cmd.getCmdProcess('superseded'), undefined);
      assert.equal(cmd.getCmdProcess('superseded-replacement-reloaded'), undefined);
      await retry();
    } finally { owner.destroy(); }
  });

  await record('navigation cancels a dispatch waiting for that package lock without starting a child later', async () => {
    const reservation = await prepare(first);
    const releaseSelection = acquireInstallLock(packageSelectionLock(ID));
    assert.ok(releaseSelection, 'Selection must release the package lock before sending the token');
    try {
      let settled = false;
      const pending = run(first, reservation, 'cancel-during-dispatch').finally(() => { settled = true; });
      pending.catch(() => {});
      await delay(150);
      assert.equal(settled, false);
      const loaded = once(first.webContents, 'did-finish-load');
      first.reload();
      await loaded;
    } finally { releaseSelection(); }
    await retry();
    await gone('cancel-during-dispatch');
    assert.equal(fs.existsSync(marker('cancel-during-dispatch')), false);
  });

  await record('real renderer crash cancels the bound runtime and releases admission', async () => {
    const owner = await open();
    try {
      const reservation = await prepare(owner);
      const running = await started(owner, reservation, 'renderer-crash');
      const exited = once(owner.webContents, 'render-process-gone');
      owner.webContents.forcefullyCrashRenderer();
      await exited;
      await gone('renderer-crash');
      assert.equal(pidAlive(running.pid), false);
      await retry();
    } finally { owner.destroy(); }
  });

  await record('window destruction stops an unregistered runtime', async () => {
    const owner = await open();
    const reservation = await prepare(owner);
    const running = await started(owner, reservation, 'window-destroy');
    owner.destroy();
    await gone('window-destroy');
    assert.equal(pidAlive(running.pid), false);
    await retry();
  });

  await record('a registered runtime with another window lease survives its original renderer crash', async () => {
    const owner = await open();
    try {
      const reservation = await prepare(owner);
      const running = await started(owner, reservation, 'shared-runtime');
      assert.equal((await register(owner, reservation, 'shared-runtime', running.pid)).success, true);
      const acquired = await invoke(other, 'childToolSession', 'acquire', { toolId: ID, leaseId: 'survivor' });
      assert.equal(acquired.streamId, 'shared-runtime');
      const exited = once(owner.webContents, 'render-process-gone');
      owner.webContents.forcefullyCrashRenderer();
      await exited;
      assert.ok(pidAlive(running.pid));
      const sessions = await invoke(other, 'childToolSession', 'list');
      assert.equal(sessions.find(session => session.streamId === 'shared-runtime')?.refCount, 1);
      assert.equal((await invoke(other, 'childToolSession', 'stop', ID)).success, true);
      await gone('shared-runtime');
    } finally { owner.destroy(); }
  });

  await record('wrong package, duplicate dispatch and wrong registration do not alter the exact command', async () => {
    const reservation = await prepare(first);
    const edited = command(reservation, 'wrong-package');
    edited.args[0] = path.join(legacy(OTHER), 'index.js');
    assert.match((await invoke(first, 'cmd', 'run', edited)).error, /SUBAPP_LAUNCH_EXPIRED/);
    const running = await started(first, reservation, 'exact-command');
    assert.match((await run(first, reservation, 'duplicate')).error, /SUBAPP_LAUNCH_EXPIRED/);
    await assert.rejects(register(first, reservation, 'duplicate', running.pid), /SUBAPP_LAUNCH_EXPIRED/);
    assert.equal((await register(first, reservation, 'exact-command', running.pid)).success, true);
    await finish(first, reservation);
    assert.ok(pidAlive(running.pid));
    assert.equal((await invoke(first, 'childToolSession', 'stop', ID)).success, true);
    await gone('exact-command');
  });

  await record('an unused Chat selection and an older shared lock do not block another tool from launching, updating or uninstalling', async () => {
    const reservation = await prepare(first);
    const releaseLegacy = acquireInstallLock(legacySelectionLock);
    assert.ok(releaseLegacy, 'An undispatched selection must not hold the legacy shared lock');
    try {
      const prior = await bounded(prepare(other, OTHER), 3000, 'The legacy shared lock blocked launch');
      assert.equal(prior.config.version, '1.0.0');
      const oldRuntime = await started(other, prior, 'other-before-update');
      assert.equal((await register(other, prior, 'other-before-update', oldRuntime.pid)).success, true);

      releases[OTHER] = '1.1.0';
      await bounded(invoke(other, 'subapps', 'update', { id: OTHER }), 10000, 'The legacy shared lock blocked update');
      assert.ok(pidAlive(oldRuntime.pid));
      assert.equal((await invoke(other, 'childToolSession', 'stop', OTHER)).success, true);
      await gone('other-before-update');

      const next = await bounded(prepare(other, OTHER), 3000, 'The updated tool could not launch');
      assert.equal(next.config.version, '1.1.0');
      const newRuntime = await started(other, next, 'other-after-update');
      assert.equal((await register(other, next, 'other-after-update', newRuntime.pid)).success, true);
      await bounded(invoke(other, 'subapps', 'uninstall', { id: OTHER }), 10000, 'The legacy shared lock blocked uninstall');
      await gone('other-after-update');
      assert.equal(fs.existsSync(next.config.packagePath), false);
      await assert.rejects(prepare(other, OTHER), /not installed/);

      const stillValid = await started(first, reservation, 'chat-after-other-uninstall');
      assert.equal((await register(first, reservation, 'chat-after-other-uninstall', stillValid.pid)).success, true);
      assert.equal((await invoke(first, 'childToolSession', 'stop', ID)).success, true);
      await gone('chat-after-other-uninstall');
    } finally { releaseLegacy(); }
  });

  await record('active version can be updated while the previous runtime is still starting', async () => {
    const reservation = await prepare(first);
    const prior = await started(first, reservation, 'update-during-start');
    releases[ID] = '1.1.0';
    await invoke(other, 'subapps', 'update', { id: ID });
    assert.ok(pidAlive(prior.pid));
    assert.ok(fs.existsSync(path.join(reservation.config.packagePath, reservation.config.entry)));
    await finish(first, reservation);
    await gone('update-during-start');
    const next = await prepare(other);
    assert.equal(next.config.version, '1.1.0');
    await finish(other, next);
  });

  await record('ten consecutive crashes and retries do not accumulate active processes or launch locks', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const reservation = await prepare(first);
      const stream = `repeated-crash-${attempt}`;
      assert.equal((await run(first, reservation, stream, 'exit')).success, true);
      await gone(stream);
      await retry();
    }
    assert.deepEqual(cmd.getActiveCmdProcesses(), []);
  });

  await record('uninstall protects an unregistered running process and succeeds after it stops', async () => {
    const reservation = await prepare(first);
    await started(first, reservation, 'uninstall-during-start');
    await assert.rejects(invoke(other, 'subapps', 'uninstall', { id: ID }), /EBUSY|占用|in use|busy/i);
    assert.ok(fs.existsSync(path.join(reservation.config.packagePath, reservation.config.entry)));
    await finish(first, reservation);
    await gone('uninstall-during-start');
    await invoke(other, 'subapps', 'uninstall', { id: ID });
    await assert.rejects(prepare(other), /not installed/);
  });
}

async function main() {
  const mode = process.argv.at(-1);
  if (mode !== 'recover') seed();
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const first = await open();
  cmd.registerCmdHandlers(first);
  windows.registerWindowHandlers(first);
  registerSubappManagerHandlers(() => first, {
    getIndexUrl: () => `${baseUrl()}/index-${Object.values(releases).join('-')}.json`,
    listChildToolHoldersForCatalogId: windows.listChildToolHoldersForCatalogId,
    getRunningSubappConfig: windows.getRunningSubappConfig,
    forceStopChildToolByCatalogId: windows.forceStopChildToolByCatalogId,
  });
  if (mode === 'hold') {
    const releaseLegacy = acquireInstallLock(legacySelectionLock);
    assert.ok(releaseLegacy);
    try {
      const releaseSelection = acquireInstallLock(packageSelectionLock(ID));
      assert.ok(releaseSelection);
      try {
        fs.writeFileSync(path.join(directory, 'holding'), String(process.pid));
        await new Promise(() => {});
      } finally { releaseSelection(); }
    } finally { releaseLegacy(); }
  } else if (mode === 'recover') {
    assert.equal(acquireInstallLock(legacySelectionLock), null);
    const selection = await bounded(prepare(first, OTHER), 3000, 'An older host held the shared lock');
    const runtime = await started(first, selection, 'while-legacy-host-holds-lock');
    assert.equal((await register(first, selection, 'while-legacy-host-holds-lock', runtime.pid)).success, true);
    assert.equal((await invoke(first, 'childToolSession', 'stop', OTHER)).success, true);
    await gone('while-legacy-host-holds-lock');

    let settled = false;
    const waiting = prepare(first).finally(() => { settled = true; });
    waiting.catch(() => {});
    await delay(150);
    assert.equal(settled, false, 'The same package must wait on the live holder');
    fs.writeFileSync(path.join(directory, 'launched'), '');

    const recovered = await bounded(waiting, 8000, 'The killed owner left its package selection locked');
    const recoveredRuntime = await started(first, recovered, 'after-package-lock-holder-exit');
    assert.equal((await register(first, recovered, 'after-package-lock-holder-exit', recoveredRuntime.pid)).success, true);
    assert.equal((await invoke(first, 'childToolSession', 'stop', ID)).success, true);
    await gone('after-package-lock-holder-exit');
    const release = await until(() => acquireInstallLock(legacySelectionLock), 'The killed owner left its old shared lock active');
    release();
    fs.writeFileSync(path.join(directory, 'recovered'), '');
  } else {
    await runMatrix(first, await open());
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    assert.equal(await cmd.killAllCmdProcesses(), true);
    assert.deepEqual(cmd.getActiveCmdProcesses(), []);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
    app.exit(process.exitCode || 0);
  }
});
