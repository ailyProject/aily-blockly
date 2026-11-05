const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { LibraryHistory } = require('../../electron/library-history');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-history-intent-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = dependencies => fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies }));
  write({ example: '1.0.0' });
  return { root, write };
}

test('history records dependency intent without walking, copying or hashing installed library contents', async t => {
  const { root, write } = fixture(t), reads = [];
  const source = path.join(root, 'node_modules/example');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'large-font.bin'), Buffer.alloc(1024 * 1024, 17));
  const guardedFs = { ...fs,
    readdirSync() { throw new Error('history must not enumerate sources'); },
    cpSync() { throw new Error('history must not copy sources'); },
    mkdtempSync() { throw new Error('history must not create backup directories'); },
    readFileSync(file, ...args) {
      reads.push(file);
      assert.ok(['package.json', 'package-lock.json'].includes(path.basename(file)));
      return fs.readFileSync(file, ...args);
    },
  };
  const context = { module: { exports: {} }, process,
    require: name => name === 'node:fs' ? guardedFs : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../electron/library-history.js'), 'utf8'), context);
  const history = new context.module.exports.LibraryHistory();
  const { token } = await history.begin(root, ['example']);
  write({});
  assert.equal((await history.commit(root, token)).changed, true);
  const plan = await history.preview(root, token, false);
  assert.equal(plan.changes[0].after, '1.0.0');
  assert.ok(JSON.stringify(history.get(root, token)).length < 2000);
  assert.ok(reads.length <= 12);
  await history.discard(root, token);
  assert.equal(fs.statSync(path.join(source, 'large-font.bin')).size, 1024 * 1024);
});

test('preview is read-only and rejects newer manifest or lock resolutions', async t => {
  const { root, write } = fixture(t), history = new LibraryHistory();
  const lock = path.join(root, 'package-lock.json');
  fs.writeFileSync(lock, '{"version":"before"}');
  const { token } = await history.begin(root, ['example']);
  write({}); fs.writeFileSync(lock, '{"version":"after"}');
  await history.commit(root, token);
  const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.deepEqual((await history.preview(root, token, false)).changes,
    [{ name: 'example', field: 'dependencies', before: null, after: '1.0.0' }]);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
  write({ other: '2.0.0' });
  await assert.rejects(history.prepare(root, token, false), { code: 'LIBRARY_HISTORY_CONFLICT' });
  write({}); fs.writeFileSync(lock, '{"version":"external"}');
  await assert.rejects(history.prepare(root, token, false), { code: 'LIBRARY_HISTORY_CONFLICT' });
});

test('local source edits are not snapshots and are never reverted by history', async t => {
  const { root, write } = fixture(t), history = new LibraryHistory();
  const local = path.join(root, 'local-libraries/example'), logical = path.join(root, 'node_modules/example');
  fs.mkdirSync(local, { recursive: true }); fs.mkdirSync(path.dirname(logical));
  fs.writeFileSync(path.join(local, 'package.json'), '{"name":"example","version":"1.0.0"}');
  fs.symlinkSync(local, logical, process.platform === 'win32' ? 'junction' : 'dir');
  const { token } = await history.begin(root, ['example']);
  fs.unlinkSync(logical); write({}); await history.commit(root, token);
  fs.writeFileSync(path.join(local, 'user.h'), 'new manual edit');
  const { target } = await history.prepare(root, token, false);
  await history.restoreLinks(root, target);
  assert.equal(fs.realpathSync(logical), local);
  assert.equal(fs.readFileSync(path.join(local, 'user.h'), 'utf8'), 'new manual edit');
});

test('history validates project identity and package paths, and detects no-op dependency operations', async t => {
  const { root } = fixture(t), history = new LibraryHistory();
  await assert.rejects(history.begin(root, ['../outside']), { code: 'LIBRARY_HISTORY_CONFLICT' });
  const { token } = await history.begin(root, ['example@1.0.0']);
  assert.equal((await history.commit(root, token)).changed, false);
  await assert.rejects(history.prepare(root + '-other', token, false), { code: 'LIBRARY_HISTORY_CONFLICT' });
  await history.discard(root, token);
  await assert.rejects(history.prepare(root, token, false), { code: 'LIBRARY_HISTORY_CONFLICT' });
});
