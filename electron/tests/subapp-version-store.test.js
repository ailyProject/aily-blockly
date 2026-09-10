const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../subapp-version-store');

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
  });
}

test('publishes the approved A path and an active manifest with relative locators', (t) => {
  const { root } = fixture(t);
  const prepared = prepare(root);
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

test('keeps versions side by side and falls back to the verified previous version', (t) => {
  const { root } = fixture(t);
  const oldEntry = { ...ENTRY, version: '0.1.32' };
  const old = prepare(root, oldEntry, { distribution: null, integrity: 'sha512-b2xk' });
  store.activate(root, oldEntry, old);
  const current = prepare(root);
  store.activate(root, ENTRY, current);
  fs.rmSync(path.join(current.packagePath, 'package.json'));
  const selected = store.readSelection(root, { id: ENTRY.id, package: ENTRY.package });
  assert.equal(selected.version, '0.1.32');
  assert.equal(selected.fallback, true);
  assert.match(selected.selectionError, /ENOENT/);
  assert.ok(fs.existsSync(path.join(old.packagePath, 'package.json')));
});

test('same-version repair uses a staged replacement and never mutates files in place', (t) => {
  const { root } = fixture(t);
  const first = prepare(root, ENTRY, { marker: 'first' });
  assert.equal(fs.readFileSync(path.join(first.packagePath, 'marker.txt'), 'utf8'), 'first');
  const second = prepare(root, ENTRY, { marker: 'second', replace: true });
  assert.equal(second.packagePath, first.packagePath);
  assert.equal(fs.readFileSync(path.join(second.packagePath, 'marker.txt'), 'utf8'), 'second');
  assert.equal(fs.readdirSync(path.dirname(second.project)).some(name => name.startsWith('.replaced-')), false);
});

test('relative active locators continue to work after moving the whole npm prefix', (t) => {
  const { temporary, root } = fixture(t);
  const prepared = prepare(root);
  store.activate(root, ENTRY, prepared, { mode: 'pinned' });
  const moved = path.join(temporary, 'moved prefix', 'app');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(root, moved);
  const selected = store.readSelection(moved, { id: ENTRY.id, package: ENTRY.package });
  assert.equal(selected.packagePath, path.join(moved, 'store', 'subapp-aily-chat', '0.1.33', 'source'));
  assert.equal(selected.selectionMode, 'pinned');
});

test('uninstall marker survives version deletion and is cleared only after cleanup completes', (t) => {
  const { root } = fixture(t);
  prepare(root);
  store.beginUninstall(root, ENTRY);
  assert.equal(store.isUninstalling(root, ENTRY), true);
  store.removeAllVersions(root, ENTRY);
  assert.equal(fs.existsSync(path.join(root, 'store', 'subapp-aily-chat')), false);
  assert.equal(store.isUninstalling(root, ENTRY), true);
  store.finishUninstall(root, ENTRY);
  assert.equal(store.isUninstalling(root, ENTRY), false);
});

test('rejects unsafe package keys, non-canonical versions and forged candidates', (t) => {
  const { root } = fixture(t);
  for (const entry of [
    { ...ENTRY, package: '@aily-project/CON' },
    { ...ENTRY, version: 'v0.1.33' },
    { ...ENTRY, version: '../0.1.33' },
  ]) assert.throws(() => store.createCandidate(root, entry), /Unsafe|Invalid/);
  const candidate = store.createCandidate(root, ENTRY);
  writePackage(candidate.source, ENTRY);
  assert.throws(() => store.publishCandidate(root, ENTRY, {
    ...candidate, project: path.join(root, 'outside'), source: candidate.source,
  }, { distribution: DIST }), /candidate path is invalid/);
});
