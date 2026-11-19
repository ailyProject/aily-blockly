const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { test } = require('node:test');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');
const { rootAttachment } = require('../../electron/project-file-lock-owner');
const root = path.resolve(__dirname, '../test-results/r0-publication-r1-lock');
fs.mkdirSync(root, { recursive: true });
const project = () => fs.mkdtempSync(path.join(root, 'project-'));

test('directory-handle identity preserves the actual volume when Electron path stats report dev zero', () => {
  const directory = project(), expected = rootAttachment(directory);
  let opened = 0, closed = 0;
  const files = { ...fs,
    lstatSync(target, options) {
      const stat = fs.lstatSync(target, options);
      if (!options?.bigint) return stat;
      const electronPathStat = Object.create(stat); electronPathStat.dev = 0n;
      return electronPathStat;
    },
    openSync(...args) { opened++; return fs.openSync(...args); },
    closeSync(...args) { closed++; return fs.closeSync(...args); },
  };
  const actual = rootAttachment(directory, files);
  assert.equal(actual.identity.dev, expected.identity.dev, 'Do not publish Electron path-stat dev=0 as the physical volume identity');
  assert.deepEqual(actual, expected); assert.equal(opened, 1); assert.equal(closed, 1);
});

test('directory-handle identity rejects changed inode, birth, volume or link observations and closes every opened descriptor', () => {
  for (const scenario of ['inode', 'birth', 'volume', 'path-after-inode', 'path-after-birth', 'path-after-link', 'path-before-volume']) {
    const directory = project(); let opened = 0, closed = 0, paths = 0;
    const files = { ...fs,
      lstatSync(target, options) {
        const stat = fs.lstatSync(target, options), changed = Object.create(stat); paths++;
        if (scenario === 'path-before-volume' && paths === 1) changed.dev = stat.dev + 1n;
        if (paths > 1 && scenario === 'path-after-inode') changed.ino = stat.ino + 1n;
        if (paths > 1 && scenario === 'path-after-birth') changed.birthtimeNs = stat.birthtimeNs + 1n;
        if (paths > 1 && scenario === 'path-after-link') changed.isSymbolicLink = () => true;
        return changed;
      },
      fstatSync(...args) {
        const stat = fs.fstatSync(...args), changed = Object.create(stat);
        if (scenario === 'inode') changed.ino = stat.ino + 1n;
        if (scenario === 'birth') changed.birthtimeNs = stat.birthtimeNs + 1n;
        if (scenario === 'volume') changed.dev = stat.dev + 1n;
        return changed;
      },
      openSync(...args) { opened++; return fs.openSync(...args); },
      closeSync(...args) { closed++; return fs.closeSync(...args); },
    };
    assert.throws(() => rootAttachment(directory, files), { code: 'PROJECT_FILE_UNSAFE_PATH' }, scenario);
    assert.equal(opened, 1, scenario); assert.equal(closed, 1, scenario);
  }
});

test('directory-handle identity fails closed on IO or incomplete descriptor stats, without leaking a descriptor', () => {
  for (const scenario of ['open-denied', 'fstat-failed', 'fstat-unknown', 'after-lstat-failed']) {
    const directory = project(); let opened = 0, closed = 0, paths = 0;
    const files = { ...fs,
      openSync(...args) { if (scenario === 'open-denied') throw Object.assign(new Error('denied'), { code: 'EACCES' }); opened++; return fs.openSync(...args); },
      closeSync(...args) { closed++; return fs.closeSync(...args); },
      fstatSync(...args) {
        if (scenario === 'fstat-failed') throw Object.assign(new Error('read failed'), { code: 'EIO' });
        const stat = fs.fstatSync(...args), changed = Object.create(stat);
        if (scenario === 'fstat-unknown') changed.birthtimeNs = undefined;
        return changed;
      },
      lstatSync(...args) { paths++; if (paths > 1 && scenario === 'after-lstat-failed') throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return fs.lstatSync(...args); },
    };
    assert.throws(() => rootAttachment(directory, files));
    assert.equal(opened, scenario === 'open-denied' ? 0 : 1); assert.equal(closed, opened, scenario);
  }
});

test('host-only readonly attachment is exact bigint identity; copying the root changes it', async () => {
  const original = project(), storage = await openProjectSyncStorage(original, () => {});
  const stat = fs.lstatSync(original, { bigint: true });
  assert.deepEqual(storage.attachment, { version: 1, root: fs.realpathSync(original),
    identity: { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) } });
  assert.equal(storage.executor.storagePid, process.pid);
  const archived = original + '-archived';
  fs.renameSync(original, archived); fs.cpSync(archived, original, { recursive: true });
  await assert.rejects(storage.read('project.abi'), { code: 'PROJECT_FILE_UNSAFE_PATH' });
  const replacement = await openProjectSyncStorage(original, () => {});
  assert.notDeepEqual(replacement.attachment, storage.attachment);
});

test('a real hard-killed owner is safely reclaimed without deleting live owner bytes', async () => {
  const directory = project();
  const child = fork(path.join(__dirname, 'fixtures/r0-publication-lock-worker.cjs'), [directory],
    { execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  const closed = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Owned lock worker did not pause: ' + stderr)), 15000);
      child.once('message', value => { clearTimeout(timeout); value.error ? reject(Object.assign(new Error(value.error.message), value.error)) : resolve(); });
    });
    const marker = path.join(directory, '.aily/project-files.write.lock');
    const before = fs.readFileSync(marker);
    const storage = await openProjectSyncStorage(directory, () => {}, { timeoutMs: 20 });
    await assert.rejects(storage.withLock(async () => {}), { code: 'PROJECT_FILE_BUSY' });
    assert.deepEqual(fs.readFileSync(marker), before);
    child.kill('SIGKILL'); await closed;
    await storage.withLock(async access => {
      assert.equal(await access.read('project.abi'), 'retained real bytes');
      assert.equal(await access.replace('project.abs', null, 'recovered without replay'), true);
    });
    assert.equal(fs.existsSync(marker), false);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }
});

test('cancelled writer still releases only its own marker and native lease', async () => {
  const directory = project(); let current = true;
  const storage = await openProjectSyncStorage(directory, () => {
    if (!current) throw Object.assign(new Error('Original user stop'), { code: 'USER_CANCELLED' });
  });
  await assert.rejects(storage.withLock(async access => {
    await access.replace('project.abi', null, 'source remains real');
    current = false;
    await access.read('project.abi');
  }), { code: 'USER_CANCELLED' });
  assert.equal(fs.existsSync(path.join(directory, '.aily/project-files.write.lock')), false);
  await (await openProjectSyncStorage(directory, () => {})).withLock(async () => {});
});

test('changed owner bytes remain protected even if the original writer fails during acquisition', async () => {
  const directory = project(), marker = path.join(directory, '.aily/project-files.write.lock');
  const foreign = '{"foreign":"do not delete this version"}';
  const files = { ...fs, writeFileSync(target, ...args) {
    fs.writeFileSync(target, ...args);
    if (typeof target === 'number') fs.writeFileSync(marker, foreign);
  } };
  const storage = await openProjectSyncStorage(directory, () => {}, { files });
  await assert.rejects(storage.withLock(async () => {}), { code: 'PROJECT_FILE_LOCK_CHANGED' });
  assert.equal(fs.readFileSync(marker, 'utf8'), foreign);
});

test('owner observation distinguishes exact live identity, unverified identity and a reused PID creation identity', async () => {
  const { ownerIsDead } = require('../../electron/project-file-lock-owner');
  const executor = (await openProjectSyncStorage(project(), () => {})).executor;
  const owner = { version: 2, pid: process.pid, token: 'owned-test-token',
    processIdentity: executor.processIdentity, bootId: executor.bootId };
  assert.equal(ownerIsDead(owner, executor), false);
  assert.equal(ownerIsDead({ ...owner, processIdentity: null }, executor), false);
  if (executor.processIdentity) {
    const prefix = executor.processIdentity.split(':')[0];
    assert.equal(ownerIsDead({ ...owner, processIdentity: prefix + ':1' }, executor), true,
      'A stored different creation stamp proves this PID is not the original owner; this is an identity-observer unit, not forced OS PID reuse.');
  }
  const originalKill = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
    assert.equal(ownerIsDead(owner, executor), false);
  } finally { process.kill = originalKill; }
});

test('readonly storage-executor observation distinguishes actual live/reused/unknown owners without killing', async () => {
  const { observeStorageExecutor, storageExecutor } = require('../../electron/project-file-lock-owner');
  const actual = storageExecutor();
  assert.deepEqual(observeStorageExecutor(actual), { version: 1, state: 'active', reason: 'same-instance' });
  assert.equal(observeStorageExecutor({ ...actual, storagePid: 0 }).state, 'unknown');
  const original = { ...actual, instanceId: 'different-original-instance' };
  if (actual.processIdentity) {
    assert.equal(observeStorageExecutor(original).state, 'active');
    assert.equal(observeStorageExecutor({ ...original, processIdentity: actual.processIdentity.split(':')[0] + ':1' }).state, 'exited');
  }
  const kill = process.kill;
  try {
    process.kill = (_pid, signal) => { assert.equal(signal, 0, 'Only readonly liveness observation is allowed'); throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
    assert.deepEqual(observeStorageExecutor(original), { version: 1, state: 'unknown', reason: 'process-unavailable' });
  } finally { process.kill = kill; }
});

test('readonly executor observation crosses the native plain-result bridge and retains cancelled guard codes', async () => {
  const { openProjectSyncStorageBridge } = require('../../electron/project-sync-storage');
  let current = true;
  const bridge = await openProjectSyncStorageBridge(project(), () => {
    if (!current) throw Object.assign(new Error('Original observer cancelled'), { code: 'TEST_OBSERVER_CANCELLED' });
  });
  const result = await bridge.observeExecutorResult(bridge.executor);
  assert.equal(result.ok, true); assert.equal(result.value.state, 'active');
  current = false;
  const cancelled = await bridge.observeExecutorResult(bridge.executor);
  assert.equal(cancelled.ok, false); assert.equal(cancelled.error.code, 'TEST_OBSERVER_CANCELLED');
});
