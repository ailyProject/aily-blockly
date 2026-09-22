const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { test, after } = require('node:test');
const { openProjectSyncStorage } = require('./project-sync-storage');
const { replaceProjectText } = require('./project-file-writer');
const { projectFileHash: hash } = require('./project-file-access');
const roots = [];
const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-sync-storage-')); roots.push(root); return root;
};
const guard = () => undefined;
const request = root => ({ projectPath: root, fileName: 'project.abi', expectedHash: null, content: 'single writer' });
after(() => { for (const root of roots) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('aily-sync-storage-'));
  fs.rmSync(root, { recursive: true, force: true });
} });

test('read-only open creates nothing; locked UTF-8 writes survive reopening the capability', async () => {
  const root = project(); const store = await openProjectSyncStorage(root, guard);
  assert.equal(await store.read('prepared.json'), null); assert.deepEqual(fs.readdirSync(root), []);
  const value = '\ufeff中文 😀\r\n';
  await store.withLock(async locked => {
    assert.equal(await locked.replace('baselines/g1.json', null, value), true);
    assert.equal(await locked.replace('project.abs', null, value), true);
    assert.equal(await locked.replace('project.abs', hash('stale'), 'wrong'), false);
    assert.equal(await locked.replace('prepared.json', null, 'pointer'), true);
    assert.equal(await locked.replace('prepared.json', hash('pointer'), null), true);
  });
  const reopened = await openProjectSyncStorage(root, guard);
  assert.equal(await reopened.read('baselines/g1.json'), value);
  assert.equal(await reopened.read('project.abs'), value);
  assert.equal(await reopened.read('prepared.json'), null);
  assert.equal(fs.existsSync(path.join(root, '.aily/project-files.write.lock')), false);
});

test('write access is callback-scoped, not shared with concurrent callers or usable after release', async () => {
  const root = project(); const store = await openProjectSyncStorage(root, guard); let escaped;
  assert.equal(store.replace, undefined);
  await store.withLock(async locked => {
    escaped = locked;
    const competitor = await replaceProjectText(request(root), guard, { timeoutMs: 5 });
    assert.equal(competitor.code, 'PROJECT_FILE_BUSY');
    await locked.replace('project.abi', null, 'generation');
  });
  await assert.rejects(escaped.replace('project.abi', hash('generation'), 'escaped'), { code: 'ABS_STORAGE_SCOPE_CLOSED' });
  await assert.rejects(escaped.read('project.abi'), { code: 'ABS_STORAGE_SCOPE_CLOSED' });
  assert.equal(await store.read('project.abi'), 'generation');
});

test('all keys are confined and immutable baselines/public mirrors cannot be deleted or overwritten', async () => {
  const root = project(); const store = await openProjectSyncStorage(root, guard);
  for (const key of ['../outside', 'baselines/../outside', 'baselines\\x.json', 'project.abi:stream', 'C:/x', 'package.json', 'baselines/', 'baselines/..json']) {
    await assert.rejects(store.read(key), { code: 'ABS_STORAGE_KEY_INVALID' });
  }
  await store.withLock(async locked => {
    await locked.replace('baselines/g.json', null, 'one');
    assert.equal(await locked.replace('baselines/g.json', null, 'two'), false);
    await assert.rejects(locked.replace('baselines/g.json', hash('one'), 'two'), { code: 'ABS_STORAGE_WRITE_INVALID' });
    for (const key of ['project.abi', 'project.abs', 'project.abs.map.json', 'committed.json', 'baselines/g.json']) {
      await assert.rejects(locked.replace(key, null, null), { code: 'ABS_STORAGE_WRITE_INVALID' });
    }
  });
  assert.equal(await store.read('baselines/g.json'), 'one');
});

test('known conflicts and exact no-ops do not create temporary files', async () => {
  const root = project(); fs.writeFileSync(path.join(root, 'project.abi'), 'before');
  const files = { ...fs, promises: { ...fs.promises, open() { throw new Error('unexpected write'); } } };
  const store = await openProjectSyncStorage(root, guard, { files });
  await store.withLock(async locked => {
    assert.equal(await locked.replace('project.abi', null, 'after'), false);
    assert.equal(await locked.replace('project.abi', hash('before'), 'before'), true);
  });
});

test('stale renderer and an external edit during temp preparation stop the final rename', async () => {
  for (const cause of ['stale', 'external']) {
    const root = project(); fs.writeFileSync(path.join(root, 'project.abi'), 'before'); let current = true;
    const files = { ...fs, promises: { ...fs.promises, async open(...args) {
      const handle = await fs.promises.open(...args);
      if (cause === 'stale') current = false;
      else fs.writeFileSync(path.join(root, 'project.abi'), 'external');
      return handle;
    } } };
    const store = await openProjectSyncStorage(root, () => { if (!current) throw new Error('stale'); }, { files });
    if (cause === 'stale') await assert.rejects(store.withLock(async locked => locked.replace('project.abi', hash('before'), 'after')), /stale/);
    else assert.equal(await store.withLock(async locked => locked.replace('project.abi', hash('before'), 'after')), false);
    assert.equal(fs.readFileSync(path.join(root, 'project.abi'), 'utf8'), cause === 'stale' ? 'before' : 'external');
    assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
  }
});

test('unawaited writes are revoked and drained before the shared lock is released', async () => {
  const root = project(); const store = await openProjectSyncStorage(root, guard); let pending;
  await store.withLock(async locked => { pending = locked.replace('project.abi', null, 'late'); });
  await assert.rejects(pending, { code: 'ABS_STORAGE_SCOPE_CLOSED' });
  assert.equal(await store.read('project.abi'), null);
  assert.equal((await replaceProjectText(request(root), guard)).status, 'COMMITTED');
});

test('rejects linked storage, hard-linked records, and invalid UTF-8 without rewriting them', async () => {
  const root = project(); const outside = project();
  fs.mkdirSync(path.join(root, '.aily')); fs.symlinkSync(outside, path.join(root, '.aily/abs-sync'), 'junction');
  const linked = await openProjectSyncStorage(root, guard);
  await assert.rejects(linked.read('prepared.json'), { code: 'PROJECT_FILE_UNSAFE_PATH' });
  const regular = project(); fs.writeFileSync(path.join(outside, 'record'), 'original');
  fs.linkSync(path.join(outside, 'record'), path.join(regular, 'project.abi'));
  const store = await openProjectSyncStorage(regular, guard);
  await assert.rejects(store.read('project.abi'), { code: 'PROJECT_FILE_UNSAFE_PATH' });
  fs.writeFileSync(path.join(regular, 'project.abs'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(store.read('project.abs'), { code: 'ABS_STORAGE_ENCODING_INVALID' });
});

test('callback failure leaves completed files for recovery but releases only its own lock', async () => {
  const root = project(); const store = await openProjectSyncStorage(root, guard);
  await assert.rejects(store.withLock(async locked => {
    await locked.replace('prepared.json', null, 'recover me');
    await locked.replace('project.abi', null, 'committed ABI');
    throw new Error('interrupted');
  }), /interrupted/);
  assert.equal(await store.read('prepared.json'), 'recover me');
  assert.equal(await store.read('project.abi'), 'committed ABI');
  assert.equal(fs.existsSync(path.join(root, '.aily/project-files.write.lock')), false);
});

test('post-rename failure is read back, but unreadable outcome is UNKNOWN', async () => {
  for (const unreadable of [false, true]) {
    const root = project(); let renamed = false;
    const files = { ...fs, renameSync(...args) { fs.renameSync(...args); renamed = true; throw new Error('lost acknowledgement'); },
      readFileSync(file, ...args) {
        if (unreadable && renamed && file === path.join(root, 'project.abi')) throw new Error('cannot inspect');
        return fs.readFileSync(file, ...args);
      } };
    const store = await openProjectSyncStorage(root, guard, { files });
    const result = store.withLock(async locked => locked.replace('project.abi', null, 'after'));
    if (unreadable) await assert.rejects(result, { code: 'ABS_COMMIT_UNCERTAIN' });
    else assert.equal(await result, true);
    assert.equal(fs.readFileSync(path.join(root, 'project.abi'), 'utf8'), 'after');
  }
});

test('replaced internal directory invalidates existing capabilities even if both are regular directories', async () => {
  const root = project(); const store = await openProjectSyncStorage(root, guard);
  await store.withLock(async locked => locked.replace('baselines/g.json', null, 'original'));
  const directory = path.join(root, '.aily/abs-sync');
  const moved = path.join(root, '.aily/abs-sync-retained');
  assert.equal(path.dirname(path.resolve(moved)), path.join(path.resolve(root), '.aily'));
  fs.renameSync(directory, moved); fs.mkdirSync(directory);
  await assert.rejects(store.read('prepared.json'), { code: 'PROJECT_FILE_UNSAFE_PATH' });
  assert.equal(fs.readFileSync(path.join(moved, 'baselines/g.json'), 'utf8'), 'original');
});

test('a changed lock owner is retained and the transaction reports uncertainty', async () => {
  const root = project(); const store = await openProjectSyncStorage(root, guard);
  const lock = path.join(root, '.aily/project-files.write.lock');
  await assert.rejects(store.withLock(async locked => {
    await locked.replace('project.abi', null, 'saved');
    fs.writeFileSync(lock, 'replacement owner');
  }), { code: 'ABS_COMMIT_UNCERTAIN' });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'replacement owner');
});

test('unknown abandoned locks are never stolen', async () => {
  const root = project(); fs.mkdirSync(path.join(root, '.aily'));
  const lock = path.join(root, '.aily/project-files.write.lock'); fs.writeFileSync(lock, 'unknown');
  const store = await openProjectSyncStorage(root, guard, { timeoutMs: 5 });
  await assert.rejects(store.withLock(async () => {}), { code: 'PROJECT_FILE_BUSY' });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'unknown');
});

test('a pending journal blocks ordinary saves after lock release, including malformed journals and no-ops', async () => {
  const root = project(); const store = await openProjectSyncStorage(root, guard);
  await store.withLock(async locked => locked.replace('prepared.json', null, 'malformed but retained'));
  assert.equal((await replaceProjectText(request(root), guard)).code, 'ABS_TRANSACTION_PENDING');
  fs.writeFileSync(path.join(root, 'project.abi'), 'single writer');
  assert.equal((await replaceProjectText({ ...request(root), expectedHash: hash('single writer') }, guard)).code, 'ABS_TRANSACTION_PENDING');
  assert.equal(await store.read('prepared.json'), 'malformed but retained');
  await store.withLock(async locked => locked.replace('prepared.json', hash('malformed but retained'), null));
  assert.equal((await replaceProjectText({ ...request(root), expectedHash: hash('single writer') }, guard)).status, 'COMMITTED');
});
