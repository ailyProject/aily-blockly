const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LibraryEnvironmentJournal, tree } = require('../../electron/library-environment-journal');

function fixture(t) {
  const parent = path.resolve('tests/test-results/r2-environment-tree-realpath'); fs.mkdirSync(parent, { recursive: true });
  const suite = fs.mkdtempSync(path.join(parent, 'owned-')), root = path.join(suite, 'project'); fs.mkdirSync(root);
  t.after(() => { assert.ok(suite.startsWith(parent + path.sep)); fs.rmSync(suite, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"tree-resolver"}');
  return { suite, root: fs.realpathSync(root) };
}
function resolution(mode, operation) {
  const original = fs.realpathSync, native = original.native; let ordinaryCalls = 0, nativeCalls = 0;
  const wrapped = (...args) => { ordinaryCalls++; return original(...args); };
  if (mode === 'native') wrapped.native = (...args) => { nativeCalls++; return native(...args); };
  fs.realpathSync = wrapped;
  try { return { value: operation(), ordinaryCalls, nativeCalls }; }
  finally { fs.realpathSync = original; }
}

test('native and fallback tree resolution retain exactly the same source bytes, entries and hash', t => {
  const f = fixture(t), source = path.join(f.suite, 'source'); fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"tree-source"}'); fs.writeFileSync(path.join(source, 'nested/source.txt'), '原库完整内容\n');
  const fallback = resolution('fallback', () => tree(source)), native = resolution('native', () => tree(source));
  assert.deepEqual(native.value, fallback.value);
  assert.ok(fallback.ordinaryCalls > 0); assert.equal(fallback.nativeCalls, 0);
  assert.ok(native.nativeCalls > 0); assert.equal(native.ordinaryCalls, 0, 'Per-node canonicalization must prefer the existing native resolver');
});

test('actual directory cycles and linked destination parents still reject in both resolver modes', t => {
  for (const mode of ['fallback', 'native']) {
    const f = fixture(t), cycle = path.join(f.suite, 'cycle'); fs.mkdirSync(cycle);
    fs.symlinkSync(cycle, path.join(cycle, 'back'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resolution(mode, () => tree(cycle)), { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
    const outside = path.join(f.suite, 'outside'); fs.mkdirSync(path.join(outside, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'pkg/value.txt'), 'independent external bytes');
    fs.symlinkSync(outside, path.join(f.root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const journal = new LibraryEnvironmentJournal(); journal.begin(f.root, { operation: 'linked-parent' }, null, () => {});
    assert.throws(() => resolution(mode, () => journal.preserve(f.root, ['node_modules/pkg'], () => {})), { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
    assert.equal(fs.readFileSync(path.join(outside, 'pkg/value.txt'), 'utf8'), 'independent external bytes');
  }
});

test('native canonicalization preserves old linked library bytes without compensating the external source', t => {
  for (const mode of ['fallback', 'native']) {
    const f = fixture(t), external = path.join(f.suite, 'external'); fs.mkdirSync(external); fs.mkdirSync(path.join(f.root, 'node_modules'));
    fs.writeFileSync(path.join(external, 'value.txt'), 'original library bytes');
    const logical = path.join(f.root, 'node_modules/pkg'); fs.symlinkSync(external, logical, process.platform === 'win32' ? 'junction' : 'dir');
    const journal = new LibraryEnvironmentJournal(), operation = journal.begin(f.root, { operation: 'source-preservation' }, null, () => {});
    resolution(mode, () => journal.preserve(f.root, ['node_modules/pkg'], () => {}));
    fs.writeFileSync(path.join(external, 'value.txt'), 'new external source');
    resolution(mode, () => journal.restore(f.root, operation, () => {}));
    assert.equal(fs.readFileSync(path.join(logical, 'value.txt'), 'utf8'), 'original library bytes');
    assert.equal(fs.lstatSync(logical).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(external, 'value.txt'), 'utf8'), 'new external source');
  }
});
