const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { openProjectSyncStorage, openProjectSyncStorageBridge } = require('../../electron/project-sync-storage');
const { MAX_PROJECT_FILE_BYTES } = require('../../electron/project-file-access');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const parent = path.resolve('tests/test-results/r2-history-object-storage'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'owned-'));
  t.after(() => { assert.ok(root.startsWith(parent + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, key: value => 'history-objects/' + value,
    file: value => path.join(root, '.workspace-history/objects', value.slice(0, 2), value + '.blob'),
    seed(bytes) { const hash = digest(bytes), file = this.file(hash); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return hash; } };
}

test('the existing storage port reads a complete UTF-8 History object larger than the CLI body limit', async t => {
  const f = fixture(t), text = '# complete ABS history\n' + '原工程内容\n'.repeat(110000), hash = f.seed(text);
  assert.ok(Buffer.byteLength(text) > 1024 * 1024);
  const storage = await openProjectSyncStorage(f.root, () => {});
  assert.equal(await storage.read(f.key(hash)), text);
  assert.equal(await storage.withLock(locked => locked.read(f.key(hash))), text);
  const bridge = await openProjectSyncStorageBridge(f.root, () => {});
  assert.deepEqual(await bridge.readResult(f.key(hash)), { ok: true, value: text });
});

test('missing History parents and objects return null without creating History directories', async t => {
  const f = fixture(t), hash = 'a'.repeat(64), storage = await openProjectSyncStorage(f.root, () => {});
  assert.equal(await storage.read(f.key(hash)), null); assert.deepEqual(fs.readdirSync(f.root), []);
  fs.mkdirSync(path.join(f.root, '.workspace-history/objects'), { recursive: true });
  assert.equal(await storage.read(f.key(hash)), null);
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.workspace-history/objects')), []);
  fs.mkdirSync(path.dirname(f.file(hash)));
  assert.equal(await storage.read(f.key(hash)), null); assert.equal(fs.existsSync(f.file(hash)), false);
});

test('History storage rejects traversal, extra path components and noncanonical hash keys', async t => {
  const f = fixture(t), storage = await openProjectSyncStorage(f.root, () => {}), hash = 'a'.repeat(64);
  for (const key of ['history-objects/../package.json', 'history-objects/' + 'A'.repeat(64), 'history-objects/' + hash + '.blob',
    'history-objects/' + hash + '/child', 'history-objects\\' + hash, 'history-objects/' + hash.slice(1), 'history-objects//'+hash,
    'history-objects/' + hash + '\n']) {
    await assert.rejects(storage.read(key), { code: 'ABS_STORAGE_KEY_INVALID' });
  }
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('a scoped writer cannot replace, no-op or delete any History object', async t => {
  const f = fixture(t), text = 'immutable source', hash = f.seed(text), storage = await openProjectSyncStorage(f.root, () => {});
  await storage.withLock(async locked => {
    for (const [expected, content] of [[null, text], ['sha256:' + hash, text], ['sha256:' + hash, null], [null, null]]) {
      await assert.rejects(locked.replace(f.key(hash), expected, content), { code: 'ABS_STORAGE_WRITE_INVALID' });
    }
    await assert.rejects(locked.replace(f.key('b'.repeat(64)), null, 'new object'), { code: 'ABS_STORAGE_WRITE_INVALID' });
  });
  assert.equal(fs.readFileSync(f.file(hash), 'utf8'), text); assert.equal(fs.existsSync(f.file('b'.repeat(64))), false);
  const bridge = await openProjectSyncStorageBridge(f.root, () => {});
  const denied = await bridge.withLockResult((locked, settle) => { void locked.replaceResult(f.key(hash), 'sha256:' + hash, text).then(settle); });
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'ABS_STORAGE_WRITE_INVALID');
});

test('every History ancestor rejects a junction and remembers its physical identity across reads', async t => {
  for (const targetDirectory of ['.workspace-history', '.workspace-history/objects', '.workspace-history/objects/aa']) {
    const f = fixture(t), outside = path.join(f.root, 'owned-external'); fs.mkdirSync(outside);
    const linked = path.join(f.root, targetDirectory); fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const storage = await openProjectSyncStorage(f.root, () => {});
    await assert.rejects(storage.read(f.key('a'.repeat(64))), { code: 'PROJECT_FILE_UNSAFE_PATH' });
  }
  const f = fixture(t), hash = f.seed('original object'), storage = await openProjectSyncStorage(f.root, () => {});
  assert.equal(await storage.read(f.key(hash)), 'original object');
  fs.renameSync(path.dirname(f.file(hash)), path.join(f.root, 'retained-original-shard'));
  fs.mkdirSync(path.dirname(f.file(hash))); fs.writeFileSync(f.file(hash), 'original object');
  await assert.rejects(storage.read(f.key(hash)), { code: 'PROJECT_FILE_UNSAFE_PATH' });
});

test('a History ancestry replacement during the synchronous file read cannot return retained bytes', async t => {
  const f = fixture(t), hash = f.seed('same complete object'), file = f.file(hash); let replaced = false;
  const files = { ...fs, readFileSync(target, ...args) {
    const bytes = fs.readFileSync(target, ...args);
    if (target === file && !replaced) {
      replaced = true; fs.renameSync(path.dirname(file), path.join(f.root, 'retained-read-shard'));
      fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, bytes);
    }
    return bytes;
  } };
  const storage = await openProjectSyncStorage(f.root, () => {}, { files });
  await assert.rejects(storage.read(f.key(hash)), { code: 'PROJECT_FILE_UNSAFE_PATH' });
  assert.equal(replaced, true);
});

test('History objects retain regular-file, hardlink, UTF-8 and publication-size guards', async t => {
  const f = fixture(t), bytes = Buffer.from([0xff]), hash = f.seed(bytes), storage = await openProjectSyncStorage(f.root, () => {});
  await assert.rejects(storage.read(f.key(hash)), { code: 'ABS_STORAGE_ENCODING_INVALID' });
  fs.writeFileSync(f.file(hash), 'retained bytes'); fs.linkSync(f.file(hash), path.join(f.root, 'other-link'));
  await assert.rejects(storage.read(f.key(hash)), { code: 'PROJECT_FILE_UNSAFE_PATH' });
  fs.unlinkSync(path.join(f.root, 'other-link')); fs.truncateSync(f.file(hash), MAX_PROJECT_FILE_BYTES + 1);
  await assert.rejects(storage.read(f.key(hash)), { code: 'PROJECT_FILE_TOO_LARGE' });
});
