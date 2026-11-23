const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { test, after } = require('node:test');
const { openProjectSyncStorage, openProjectSyncStorageBridge } = require('../../electron/project-sync-storage');
const { replaceProjectText } = require('../../electron/project-file-writer');
const { projectFileHash: hash } = require('../../electron/project-file-access');
const roots = [];
const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-sync-storage-')); roots.push(root); return root;
};
const guard = () => undefined;
const request = root => ({ projectPath: root, fileName: 'project.abi', expectedHash: null, content: 'single writer' });

test('retire malformed ABS pointers without touching a draft, valid staging or a newer writer', async () => {
  const root = project(), store = await openProjectSyncStorage(root, guard);
  const sync = path.join(root, '.aily', 'abs-sync');
  fs.mkdirSync(sync, { recursive: true });
  const prepared = path.join(sync, 'prepared.json'), committed = path.join(sync, 'committed.json');
  const broken = Buffer.from([0xff, 0xf9]), valid = JSON.stringify({ schemaVersion: 1, generation: 'retained', hash: hash('saved') });
  fs.writeFileSync(path.join(root, 'project.abs'), 'an independent draft');
  fs.writeFileSync(prepared, valid);
  fs.writeFileSync(committed, broken);
  await store.retireMalformedPointers(true);
  assert.deepEqual(fs.readFileSync(committed), broken);
  assert.equal(fs.readFileSync(prepared, 'utf8'), valid);
  fs.writeFileSync(prepared, '{"cut":');
  let recovery;
  await store.withLock(async locked => {
    recovery = store.retireMalformedPointers(true);
    assert.equal(await locked.replace('prepared.json', hash('{"cut":'), valid), true);
  });
  await recovery;
  assert.equal(fs.readFileSync(prepared, 'utf8'), valid);
  assert.deepEqual(fs.readFileSync(committed), broken);
  fs.writeFileSync(prepared, '{"cut":');
  await store.retireMalformedPointers();
  assert.equal(fs.existsSync(prepared), false);
  assert.deepEqual(fs.readFileSync(committed), broken);
  await store.retireMalformedPointers(true);
  assert.equal(fs.existsSync(committed), false);
  assert.equal(fs.readFileSync(path.join(root, 'project.abs'), 'utf8'), 'an independent draft');
});

test('operation snapshot and discovery metadata survive reopening with exact conditional writes', async () => {
  const root = project(); let store = await openProjectSyncStorage(root, guard);
  const snapshot = JSON.stringify({ version: 1, document: { pages: [{ content: 'complete' }] }, candidate: 'unapplied' });
  await store.withLock(async storage => {
    assert.equal(await storage.replace('recoveries/operation-original.json', null, snapshot), true);
    assert.equal(await storage.replace('operation.json', null, 'pending-operation'), true);
    assert.equal(await storage.replace('lineage.json', null, 'relationship-only'), true);
  });
  store = await openProjectSyncStorage(root, guard);
  assert.equal(await store.read('recoveries/operation-original.json'), snapshot);
  assert.equal(await store.read('operation.json'), 'pending-operation');
  await store.withLock(async storage => {
    assert.equal(await storage.replace('operation.json', hash('different-operation'), null), false);
    await assert.rejects(storage.replace('recoveries/operation-original.json', hash(snapshot), 'overwrite'), /immutable/);
    await assert.rejects(storage.replace('lineage.json', hash('relationship-only'), null), /Invalid conditional/);
    assert.equal(await storage.replace('operation.json', hash('pending-operation'), null), true);
  });
  assert.equal(await store.read('operation.json'), null);
  assert.equal(await store.read('lineage.json'), 'relationship-only');
});
after(() => { for (const root of roots) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('aily-sync-storage-'));
  fs.rmSync(root, { recursive: true, force: true });
} });

test('old migration metadata does not gate program writes; a migration refusal still identifies its original writer', async () => {
  const root = project(), store = await openProjectSyncStorage(root, guard);
  const history = path.join(root, '.workspace-history');
  const original = randomUUID(), indexed = randomUUID(), other = randomUUID();
  const writerKey = id => `recoveries/application-writer-${hash(id).slice(7)}.json`;
  const indexKey = id => `recoveries/request-${hash(id).slice(7)}.json`;
  const receiptKey = id => `recoveries/admission-${hash('abs-apply\0' + id).slice(7)}.json`;
  const context = { attachment: store.attachment, executor: store.executor };
  const receipt = (id, changes = {}) => JSON.stringify({ version: 1, kind: 'not-started', operationId: randomUUID(),
    project: store.attachment.root, request: { operation: 'abs_apply', requestId: id }, ...context,
    code: 'ABS_WORKSPACE_MIGRATION_PENDING', message: 'Prepared workspace migration.', ...changes });
  await store.withLock(async locked => {
    for (const requestId of [original, indexed, other]) await locked.replace(writerKey(requestId), null, JSON.stringify({
      version: 1, kind: 'validated-writer', project: store.attachment.root, requestId,
      candidateHash: hash('original draft'), ...context,
    }));
    await locked.replace(indexKey(indexed), null, '{}');
    await locked.replace('project.abi', null, 'accepted ABI');
  });
  fs.mkdirSync(history);
  const migration = '{"executionMigration":{"phase":"prepared"}}';
  fs.writeFileSync(path.join(history, 'workspace.json'), migration);
  const body = receipt(original);
  await store.withLock(async locked => {
    const denied = (key, content) => assert.rejects(locked.replace(key, null, content), { code: 'ABS_ADMISSION_INVALID' });
    assert.equal(await locked.replace('project.abs', null, 'current author'), true);
    assert.equal(await locked.replace('operation.json', null, '{}'), true);
    await denied(receiptKey(indexed), receipt(indexed));
    await denied(receiptKey(other), body);
    await denied(receiptKey(other), receipt(other, { executor: { ...store.executor, instanceId: randomUUID() } }));
    const missingWriter = randomUUID();
    await denied(receiptKey(missingWriter), receipt(missingWriter));
    assert.equal(await locked.replace(receiptKey(original), null, body), true);
    assert.equal(await locked.replace(receiptKey(original), null, receipt(original)), false);
  });
  assert.equal(await store.read(receiptKey(original)), body);
  assert.equal(await store.read(receiptKey(other)), null);
  assert.equal(await store.read('project.abi'), 'accepted ABI');
  assert.equal(await store.read('history-workspace.json'), migration);
});

test('invalid UTF-8 is attributed to the specific private navigation journal', async () => {
  const root = project(), invalid = Buffer.from([0x7b, 0xff, 0xfd]);
  const sync = path.join(root, '.aily', 'abs-sync');
  fs.mkdirSync(sync, { recursive: true });
  const bridge = await openProjectSyncStorageBridge(root, guard);
  for (const [key, file, code] of [
    ['prepared.json', path.join(sync, 'prepared.json'), 'ABS_BASELINE_CORRUPT'],
    ['operation.json', path.join(sync, 'operation.json'), 'ABS_OPERATION_CORRUPT'],
    ['project.abi', path.join(root, 'project.abi'), 'ABS_STORAGE_ENCODING_INVALID'],
  ]) {
    fs.writeFileSync(file, invalid);
    const reply = await bridge.readResult(key);
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, code);
    assert.deepEqual(fs.readFileSync(file), invalid);
  }
});

test('legacy mirror recovery preserves exact malformed bytes before replacement and leaves strict reads in place', async () => {
  const root = project(), abi = '{"blocks":{}}', invalid = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0, 0x0d, 0x0a]);
  fs.writeFileSync(path.join(root, 'project.abi'), abi);
  fs.writeFileSync(path.join(root, 'project.abs'), invalid);
  fs.writeFileSync(path.join(root, 'project.abs.map.json'), invalid);
  const store = await openProjectSyncStorage(root, guard);
  await assert.rejects(store.read('project.abs'), { code: 'ABS_STORAGE_ENCODING_INVALID' });
  const expected = { abiHash: hash(abi), committedHash: null, operationHash: null };
  await store.withLock(async locked => {
    await locked.replace('prepared.json', null, 'live');
    await assert.rejects(locked.retireInvalidAbsMirror({ ...expected, key: 'project.abs', replacement: null }), { code: 'ABS_TRANSACTION_PENDING' });
    await locked.replace('prepared.json', hash('live'), null);
    await assert.rejects(locked.retireInvalidAbsMirror({ ...expected, abiHash: hash('other'), key: 'project.abs', replacement: null }), { code: 'ABS_DISK_CONFLICT' });
    assert.equal(await locked.retireInvalidAbsMirror({ ...expected, key: 'project.abs', replacement: 'verified projection' }), true);
    assert.equal(await locked.retireInvalidAbsMirror({ ...expected, key: 'project.abs.map.json', replacement: null }), true);
    assert.equal(await locked.retireInvalidAbsMirror({ ...expected, key: 'project.abs', replacement: 'never replaced' }), false);
  });
  const suffix = `raw-${hash(invalid).slice(7)}.bin`;
  for (const name of [`abs-${suffix}`, `map-${suffix}`]) {
    assert.deepEqual(fs.readFileSync(path.join(root, '.aily', 'abs-sync', 'recoveries', name)), invalid);
    await assert.rejects(store.read(`recoveries/${name}`), { code: 'ABS_STORAGE_KEY_INVALID' });
  }
  assert.equal(await store.read('project.abi'), abi);
  assert.equal(await store.read('project.abs'), 'verified projection');
  assert.equal(await store.read('project.abs.map.json'), null);
});

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
  for (const key of ['../outside', 'baselines/../outside', 'baselines\\x.json', 'project.abi:stream', 'C:/x', 'baselines/', 'baselines/..json']) {
    await assert.rejects(store.read(key), { code: 'ABS_STORAGE_KEY_INVALID' });
  }
  await store.withLock(async locked => {
    assert.equal(await locked.read('package.json'), null, 'The project manifest is an existing readonly input');
    await assert.rejects(locked.replace('package.json', null, '{}'), { code: 'ABS_STORAGE_WRITE_INVALID' });
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

test('repair archives are confined append-only originals, never arbitrary writable files', async () => {
  const root = project(); const store = await openProjectSyncStorage(root, guard);
  const original = JSON.stringify({ abs: '\ufefforiginal\r\n中文', map: '{broken', abi: 'exact bytes' });
  await store.withLock(async locked => {
    assert.equal(await locked.replace('recoveries/repair-1.json', null, original), true);
    assert.equal(await locked.replace('recoveries/repair-1.json', null, 'lost data'), false);
    await assert.rejects(locked.replace('recoveries/repair-1.json', hash(original), 'changed'), { code: 'ABS_STORAGE_WRITE_INVALID' });
    await assert.rejects(locked.replace('recoveries/repair-1.json', hash(original), null), { code: 'ABS_STORAGE_WRITE_INVALID' });
  });
  assert.equal(await store.read('recoveries/repair-1.json'), original);
  for (const key of ['recoveries/../outside.json', 'recoveries\\x.json', 'recoveries/id/file.json', 'recoveries/.json']) {
    await assert.rejects(store.read(key), { code: 'ABS_STORAGE_KEY_INVALID' });
  }
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

test('a revoked renderer with a lost settlement releases the lock after its admitted writes drain', async () => {
  const root = project();
  const entered = Promise.withResolvers(), started = Promise.withResolvers();
  const drain = Promise.withResolvers(), revoked = Promise.withResolvers();
  const files = { ...fs, promises: { ...fs.promises, async open(...args) {
    const handle = await fs.promises.open(...args);
    started.resolve();
    await drain.promise;
    return handle;
  } } };
  let current = true;
  const old = await openProjectSyncStorageBridge(root, () => {
    if (!current) {
      revoked.resolve();
      throw Object.assign(new Error('Original scope revoked'), { code: 'ORIGINAL_SCOPE_REVOKED' });
    }
  }, { files });
  const next = await openProjectSyncStorageBridge(root, guard, { timeoutMs: 20 });
  const compete = () => next.withLockResult((_locked, settle) => settle({ ok: true, value: 'new owner' }));
  const original = old.withLockResult((locked, settle) => {
    entered.resolve({ locked, settle, writing: locked.replaceResult('project.abi', null, 'old writer') });
  });
  const { locked, settle, writing } = await entered.promise;
  try {
    await started.promise;
    assert.equal((await compete()).error.code, 'PROJECT_FILE_BUSY');
    current = false;
    await revoked.promise;
    assert.equal((await compete()).error.code, 'PROJECT_FILE_BUSY');
    drain.resolve();
    assert.equal((await original).error.code, 'ORIGINAL_SCOPE_REVOKED');
    assert.equal((await writing).error.code, 'ABS_STORAGE_SCOPE_CLOSED');
    assert.deepEqual(await compete(), { ok: true, value: 'new owner' });
    settle({ ok: true, value: 'old receipt' });
    assert.equal((await locked.replaceResult('project.abi', null, 'late')).error.code, 'ABS_STORAGE_SCOPE_CLOSED');
    assert.equal(fs.existsSync(path.join(root, 'project.abi')), false);
  } finally {
    drain.resolve();
    settle({ ok: true, value: null });
  }
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
    const descriptors = new Map();
    const files = { ...fs, openSync(file, ...args) {
      const descriptor = fs.openSync(file, ...args); descriptors.set(descriptor, file); return descriptor;
    }, closeSync(descriptor) { descriptors.delete(descriptor); return fs.closeSync(descriptor); }, renameSync(...args) { fs.renameSync(...args); renamed = true; throw new Error('lost acknowledgement'); },
      readFileSync(file, ...args) {
        if (unreadable && renamed && (descriptors.get(file) ?? file) === path.join(fs.realpathSync(root), 'project.abi')) throw new Error('cannot inspect');
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
