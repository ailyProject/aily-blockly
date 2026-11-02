const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../electron/subapp-version-store');

const ENTRY = { id: 'aily-chat', package: '@aily-project/subapp-aily-chat', version: '0.1.33' };
const DIST = { tarball: 'https://registry.example.test/subapp-aily-chat.tgz', integrity: 'sha512-dGVzdA==' };

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-version-store-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return { temporary, root: path.join(temporary, 'Aily 用户', 'npm-global', 'app') };
}

function writePackage(source, entry, marker = entry.version) {
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: entry.package, version: entry.version,
  }));
  fs.writeFileSync(path.join(source, 'marker.txt'), marker);
}

function prepare(root, entry = ENTRY, options = {}) {
  const candidate = store.createCandidate(root, entry);
  writePackage(candidate.source, entry, options.marker);
  return store.publishCandidate(root, entry, candidate, {
    distribution: options.distribution === undefined ? DIST : options.distribution,
    integrity: options.integrity,
    installMode: options.installMode,
    replace: options.replace,
    retainPrevious: options.retainPrevious,
    replacementTransaction: options.replacementTransaction,
    renameAttempts: options.renameAttempts,
    sleep: options.sleep,
  });
}

test('publishes the approved A path and an active manifest with relative locators', async (t) => {
  const { root } = fixture(t);
  const prepared = await prepare(root);
  assert.equal(prepared.packagePath, path.join(root, 'store', 'subapp-aily-chat', '0.1.33', 'source'));
  assert.equal(prepared.project, path.dirname(prepared.packagePath));
  store.activate(root, ENTRY, prepared);
  const active = JSON.parse(fs.readFileSync(path.join(root, 'store', 'subapp-aily-chat', 'active.json')));
  assert.deepEqual({
    schemaVersion: active.schemaVersion,
    packageName: active.packageName,
    storeKey: active.storeKey,
    disabled: active.disabled,
    mode: active.mode,
    selected: active.selected,
  }, {
    schemaVersion: 2,
    packageName: ENTRY.package,
    storeKey: 'subapp-aily-chat',
    disabled: false,
    mode: 'auto',
    selected: { version: '0.1.33', path: '0.1.33/source', integrity: DIST.integrity },
  });
  assert.equal(path.isAbsolute(active.selected.path), false);
  assert.equal(store.readSelection(root, { id: ENTRY.id, package: ENTRY.package }).packagePath, prepared.packagePath);
});

test('retained replacement rolls back even when post-rename inspection throws before returning a prepared package', async t => {
  const { root } = fixture(t);
  const original = await prepare(root, ENTRY, { marker: 'old' });
  store.activate(root, ENTRY, original, { mode: 'pinned' });
  const candidate = store.createCandidate(root, ENTRY);
  writePackage(candidate.source, ENTRY, 'new');
  const transaction = {};
  const rename = fs.renameSync, read = fs.readFileSync;
  let replaced = false;
  fs.renameSync = (from, to, ...args) => {
    const result = rename(from, to, ...args);
    if (from === candidate.project) replaced = true;
    return result;
  };
  fs.readFileSync = (file, ...args) => {
    if (replaced && file === path.join(original.project, 'ready.json')) {
      replaced = false;
      throw Object.assign(new Error('post-rename inspection fixture'), { code: 'EIO' });
    }
    return read(file, ...args);
  };
  try {
    await assert.rejects(store.publishCandidate(root, ENTRY, candidate, {
      replace: true, retainPrevious: true, distribution: DIST, replacementTransaction: transaction,
      sleep: async () => {},
    }), /post-rename inspection fixture/);
    await transaction.rollback(); // idempotent: must not move the restored old package again.
  } finally { fs.renameSync = rename; fs.readFileSync = read; }
  assert.equal(fs.readFileSync(path.join(original.packagePath, 'marker.txt'), 'utf8'), 'old');
  assert.equal(store.readActiveManifest(root, ENTRY).mode, 'pinned');
});

test('keeps versions side by side and falls back to the verified previous version', async (t) => {
  const { root } = fixture(t);
  const oldEntry = { ...ENTRY, version: '0.1.32' };
  const old = await prepare(root, oldEntry, { distribution: null, integrity: 'sha512-b2xk' });
  store.activate(root, oldEntry, old);
  const current = await prepare(root);
  store.activate(root, ENTRY, current);
  fs.rmSync(path.join(current.packagePath, 'package.json'));
  const selected = store.readSelection(root, { id: ENTRY.id, package: ENTRY.package });
  assert.equal(selected.version, '0.1.32');
  assert.equal(selected.fallback, true);
  assert.match(selected.selectionError, /ENOENT/);
  assert.ok(fs.existsSync(path.join(old.packagePath, 'package.json')));
});

test('publishes a pinned version-dev generation as development', async (t) => {
  const { root } = fixture(t);
  const devEntry = { ...ENTRY, version: `${ENTRY.version}-dev` };
  const prepared = await prepare(root, devEntry, { distribution: null, installMode: 'development' });
  store.activate(root, devEntry, prepared, { mode: 'pinned' });

  const selected = store.readSelection(root, { id: ENTRY.id, package: ENTRY.package });
  assert.equal(selected.version, '0.1.33-dev');
  assert.equal(selected.packagePath, path.join(
    root, 'store', 'subapp-aily-chat', '0.1.33-dev', 'source',
  ));
  assert.equal(selected.installMode, 'development');
  assert.equal(selected.development, true);
  assert.equal(selected.source, 'development');
  assert.equal(selected.selectionMode, 'pinned');
});

test('publishes a pinned version-next generation as a local packaged build', async (t) => {
  const { root } = fixture(t);
  const nextEntry = { ...ENTRY, version: `${ENTRY.version}-next` };
  const prepared = await prepare(root, nextEntry, {
    distribution: null,
    integrity: 'sha512-bG9jYWwtbmV4dA==',
    installMode: 'next',
  });
  store.activate(root, nextEntry, prepared, { mode: 'pinned' });

  const selected = store.readSelection(root, { id: ENTRY.id, package: ENTRY.package });
  assert.equal(selected.version, '0.1.33-next');
  assert.equal(selected.installMode, 'next');
  assert.equal(selected.localNext, true);
  assert.equal(selected.integrity, 'sha512-bG9jYWwtbmV4dA==');
  assert.equal(selected.development, undefined);
  assert.equal(selected.source, 'version-store');
  assert.equal(selected.selectionMode, 'pinned');
});

test('same-version repair uses a staged replacement and never mutates files in place', async (t) => {
  const { root } = fixture(t);
  const first = await prepare(root, ENTRY, { marker: 'first' });
  assert.equal(fs.readFileSync(path.join(first.packagePath, 'marker.txt'), 'utf8'), 'first');
  const second = await prepare(root, ENTRY, { marker: 'second', replace: true });
  assert.equal(second.packagePath, first.packagePath);
  assert.equal(fs.readFileSync(path.join(second.packagePath, 'marker.txt'), 'utf8'), 'second');
  assert.equal(fs.readdirSync(path.dirname(second.project)).some(name => name.startsWith('.replaced-')), false);
});

test('relative active locators continue to work after moving the whole npm prefix', async (t) => {
  const { temporary, root } = fixture(t);
  const prepared = await prepare(root);
  store.activate(root, ENTRY, prepared, { mode: 'pinned' });
  const moved = path.join(temporary, 'moved prefix', 'app');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(root, moved);
  const selected = store.readSelection(moved, { id: ENTRY.id, package: ENTRY.package });
  assert.equal(selected.packagePath, path.join(moved, 'store', 'subapp-aily-chat', '0.1.33', 'source'));
  assert.equal(selected.selectionMode, 'pinned');
});

test('uninstall marker survives version deletion and is cleared only after cleanup completes', async (t) => {
  const { root } = fixture(t);
  await prepare(root);
  store.beginUninstall(root, ENTRY);
  assert.equal(store.isUninstalling(root, ENTRY), true);
  store.removeAllVersions(root, ENTRY);
  assert.equal(fs.existsSync(path.join(root, 'store', 'subapp-aily-chat')), false);
  assert.equal(store.isUninstalling(root, ENTRY), true);
  store.finishUninstall(root, ENTRY);
  assert.equal(store.isUninstalling(root, ENTRY), false);
});

test('rejects unsafe package keys, non-canonical versions and forged candidates', async (t) => {
  const { root } = fixture(t);
  for (const entry of [
    { ...ENTRY, package: '@aily-project/CON' },
    { ...ENTRY, version: 'v0.1.33' },
    { ...ENTRY, version: '../0.1.33' },
  ]) assert.throws(() => store.createCandidate(root, entry), /Unsafe|Invalid/);
  const candidate = store.createCandidate(root, ENTRY);
  writePackage(candidate.source, ENTRY);
  await assert.rejects(store.publishCandidate(root, ENTRY, {
    ...candidate, project: path.join(root, 'outside'), source: candidate.source,
  }, { distribution: DIST }), /candidate path is invalid/);
});

test('a locked staging rename retries and does not switch the active version by itself', async (t) => {
  const { root } = fixture(t);
  const previousEntry = { ...ENTRY, version: '0.1.32' };
  const previous = await prepare(root, previousEntry, { distribution: null, integrity: 'sha512-b2xk' });
  store.activate(root, previousEntry, previous);
  const activeBefore = fs.readFileSync(store.activePath(root, ENTRY), 'utf8');
  const candidate = store.createCandidate(root, ENTRY);
  writePackage(candidate.source, ENTRY, 'latest');
  const rename = fs.renameSync;
  let denied = 2;
  fs.renameSync = (from, to, ...args) => {
    if (denied > 0 && String(from).includes(`${path.sep}.staging-`) && path.basename(String(to)) === ENTRY.version) {
      denied -= 1;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
    }
    return rename.call(fs, from, to, ...args);
  };
  try {
    const prepared = await store.publishCandidate(root, ENTRY, candidate, {
      distribution: DIST, renameAttempts: 4, sleep: async () => {},
    });
    assert.equal(denied, 0);
    assert.equal(fs.readFileSync(path.join(prepared.packagePath, 'marker.txt'), 'utf8'), 'latest');
    assert.equal(fs.readFileSync(store.activePath(root, ENTRY), 'utf8'), activeBefore);
    assert.equal(store.readSelection(root, { id: ENTRY.id, package: ENTRY.package }).version, '0.1.32');
    store.activate(root, ENTRY, prepared);
    assert.equal(store.readSelection(root, { id: ENTRY.id, package: ENTRY.package }).version, ENTRY.version);
  } finally {
    fs.renameSync = rename;
  }
});

test('a rename that stays locked reports update failure and leaves the previous version selected', async (t) => {
  const { root } = fixture(t);
  const previousEntry = { ...ENTRY, version: '0.1.32' };
  const previous = await prepare(root, previousEntry, { distribution: null, integrity: 'sha512-b2xk' });
  store.activate(root, previousEntry, previous);
  const candidate = store.createCandidate(root, ENTRY);
  writePackage(candidate.source, ENTRY, 'latest');
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => {
    if (String(from).includes(`${path.sep}.staging-`) && path.basename(String(to)) === ENTRY.version) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
    }
    return rename.call(fs, from, to, ...args);
  };
  try {
    await assert.rejects(store.publishCandidate(root, ENTRY, candidate, {
      distribution: DIST, renameAttempts: 1, sleep: async () => {},
    }), (error) => {
      assert.equal(error.code, 'SUBAPP_VERSION_PUBLISH_BUSY');
      assert.match(error.message, /尚未启用|无法完成替换/);
      return true;
    });
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(store.readSelection(root, { id: ENTRY.id, package: ENTRY.package }).version, '0.1.32');
  assert.equal(fs.existsSync(path.join(root, 'store', 'subapp-aily-chat', ENTRY.version)), false);
});

test('an unreferenced broken generation is moved aside so the latest package can be published', async (t) => {
  const { root } = fixture(t);
  const previousEntry = { ...ENTRY, version: '0.1.32' };
  const previous = await prepare(root, previousEntry, { distribution: null, integrity: 'sha512-b2xk' });
  store.activate(root, previousEntry, previous);
  const broken = path.join(root, 'store', 'subapp-aily-chat', ENTRY.version);
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'partial.txt'), 'partial');
  const prepared = await prepare(root, ENTRY, { sleep: async () => {} });
  assert.equal(fs.readFileSync(path.join(prepared.packagePath, 'marker.txt'), 'utf8'), ENTRY.version);
  assert.equal(store.readSelection(root, { id: ENTRY.id, package: ENTRY.package }).version, '0.1.32');
  assert.equal(fs.existsSync(path.join(previous.packagePath, 'package.json')), true);
  store.activate(root, ENTRY, prepared);
  assert.equal(store.readSelection(root, { id: ENTRY.id, package: ENTRY.package }).version, ENTRY.version);
});
