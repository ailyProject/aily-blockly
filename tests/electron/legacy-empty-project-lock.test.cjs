'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');
const { tryAcquireFileLock } = require('../../child/scripts/native-file-lock');

const windows = { skip: process.platform !== 'win32', timeout: 15000 };
const archivePrefix = '.project-files.write.lock.retired-';
const testResults = path.resolve(__dirname, '../test-results/legacy-empty-project-lock');
fs.mkdirSync(testResults, { recursive: true });

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(testResults, 'project-')));
  const directory = path.join(root, '.aily');
  const marker = path.join(directory, 'project-files.write.lock');
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync.native(testResults));
    assert.match(path.basename(root), /^project-/);
    fs.rmSync(root, { recursive: true });
  });
  return { root, directory, marker, archived: () => fs.readdirSync(directory).filter(name => name.startsWith(archivePrefix)) };
}

async function legacy(t, root, mode) {
  const child = fork(path.join(__dirname, 'fixtures/legacy-empty-lock-worker.cjs'), [root, mode],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const ended = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
  };
  t.after(stop);
  const [entered] = await once(child, 'message', { signal: AbortSignal.timeout(6000) });
  assert.deepEqual(entered, { pid: child.pid, cut: 'before-owner-bytes' });
  return stop;
}

for (const producer of ['unguarded', 'guarded']) {
  test('legacy empty marker is archived only after its writer really exits: ' + producer, windows, async t => {
    const { root, directory, marker, archived } = fixture(t);
    const stop = await legacy(t, root, producer);
    const storage = await openProjectSyncStorage(root, () => {}, { timeoutMs: 30 });
    const before = fs.lstatSync(marker, { bigint: true });
    assert.equal(before.size, 0n);
    if (producer === 'unguarded') {
      const guard = tryAcquireFileLock(path.join(directory, 'project-files.guard'));
      assert.ok(guard, 'The native guard alone does not exclude the older writer');
      guard.close();
    }
    await assert.rejects(storage.withLock(() => assert.fail('Live legacy writer was replaced')), { code: 'PROJECT_FILE_BUSY' });
    assert.equal(fs.lstatSync(marker, { bigint: true }).ino, before.ino);
    assert.deepEqual(archived(), []);

    await stop();
    await storage.withLock(async current => {
      assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).pid, process.pid);
      assert.equal(await current.replace('project.abs', null, 'Independent new draft'), true);
    });
    assert.equal(fs.existsSync(marker), false);
    assert.equal(await storage.read('project.abs'), 'Independent new draft');
    assert.equal(archived().length, 1);
    const old = fs.lstatSync(path.join(directory, archived()[0]), { bigint: true });
    assert.equal(old.ino, before.ino);
    assert.equal(old.size, 0n);
  });
}

test('warm retirement only archives the exact abandoned marker and leaves publication to the next request', windows, async t => {
  const { root, directory, marker, archived } = fixture(t);
  const stop = await legacy(t, root, 'unguarded');
  const storage = await openProjectSyncStorage(root, () => {});
  const before = fs.lstatSync(marker, { bigint: true });
  await assert.rejects(storage.retireEmptyProjectFileLock(), { code: 'PROJECT_FILE_BUSY' });
  await stop();
  assert.equal(await storage.retireEmptyProjectFileLock(), true);
  assert.equal(await storage.retireEmptyProjectFileLock(), false);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(await storage.read('project.abs'), null);
  assert.equal(archived().length, 1);
  assert.equal(fs.lstatSync(path.join(directory, archived()[0]), { bigint: true }).ino, before.ino);

  fs.writeFileSync(marker, 'nonempty unverified journal');
  assert.equal(await storage.retireEmptyProjectFileLock(), false);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'nonempty unverified journal');
});

test('the native handle must match the marker observed before acquisition', windows, async t => {
  const { root, directory, marker, archived } = fixture(t);
  fs.mkdirSync(directory);
  fs.writeFileSync(marker, '');
  const displaced = path.join(directory, 'displaced-test-marker');
  const original = fs.lstatSync(marker, { bigint: true });
  let observations = 0;
  const files = { ...fs, lstatSync(filename, options) {
    const stat = fs.lstatSync(filename, options);
    if (filename === marker && options?.bigint && ++observations === 2) {
      fs.renameSync(marker, displaced);
      fs.writeFileSync(marker, '');
    }
    return stat;
  } };
  const storage = await openProjectSyncStorage(root, () => {}, { files });
  await assert.rejects(storage.retireEmptyProjectFileLock(), { code: 'PROJECT_FILE_LOCK_CHANGED' });
  assert.equal(fs.lstatSync(displaced, { bigint: true }).ino, original.ino);
  assert.notEqual(fs.lstatSync(marker, { bigint: true }).ino, original.ino);
  assert.deepEqual(archived(), []);
});

test('a linked marker is never treated as a legacy single-file lock', windows, async t => {
  const { root, directory, marker, archived } = fixture(t);
  fs.mkdirSync(directory);
  const alias = path.join(directory, 'test-marker-alias');
  fs.writeFileSync(marker, '');
  fs.linkSync(marker, alias);
  const storage = await openProjectSyncStorage(root, () => {}, { timeoutMs: 0 });
  await assert.rejects(storage.retireEmptyProjectFileLock(), { code: 'PROJECT_FILE_LOCK_CHANGED' });
  await assert.rejects(storage.withLock(() => assert.fail('Linked marker was touched')), { code: 'PROJECT_FILE_LOCK_CHANGED' });
  assert.equal(fs.lstatSync(alias).nlink, 2);
  assert.deepEqual(archived(), []);
});
