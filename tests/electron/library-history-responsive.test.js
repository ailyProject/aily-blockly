const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LibraryHistory } = require('../../electron/library-history');
const vm = require('node:vm');

function ioWithFs(files) {
  const context = { module: { exports: {} }, Buffer, process,
    require: name => name === 'node:fs' ? files : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../electron/library-history-io.js'), 'utf8'), context);
  return context.module.exports;
}

test('library checkpoint copying and validation leave the host event loop available', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-history-responsive-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = '@aily-project/lib-many-files', library = path.join(root, 'node_modules', name);
  fs.mkdirSync(path.join(library, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { [name]: '1.0.0' } }));
  fs.writeFileSync(path.join(library, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  for (let index = 0; index < 300; index++) fs.writeFileSync(path.join(library, 'src', `${index}.h`), Buffer.alloc(65536, index % 255));
  const history = new LibraryHistory();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  t.after(() => clearInterval(timer));
  const start = performance.now();
  const { token } = await history.begin(root, [name]);
  t.after(() => history.discard(root, token));
  t.diagnostic(`checkpoint ${Math.round(performance.now() - start)}ms; event-loop ticks ${ticks}`);
  assert.ok(ticks > 0, 'history creation blocked all event-loop ticks');
  fs.writeFileSync(path.join(library, 'src', '0.h'), 'changed by install');
  const beforeCommit = ticks;
  assert.equal((await history.commit(root, token)).changed, true);
  assert.ok(ticks > beforeCommit, 'history commit blocked all event-loop ticks');
  const { target, expected } = await history.prepare(root, token, false);
  await history.restoreSources(root, target, expected, true);
  assert.deepEqual(fs.readFileSync(path.join(library, 'src', '0.h')), Buffer.alloc(65536));
  fs.writeFileSync(path.join(library, 'src', '0.h'), 'newer user content');
  await assert.rejects(async () => history.prepare(root, token, true), { code: 'LIBRARY_HISTORY_CONFLICT' });
});

test('copy-interval file replacement is rejected even when every byte and mtime is retained', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-history-race-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, 'node_modules', 'example');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(library, 'package.json'), '{"name":"example"}');
  const source = path.join(library, 'test.h');
  fs.writeFileSync(source, 'same source bytes');
  let replaced = false, sourceDescriptor;
  const io = ioWithFs({ ...fs, openSync: (...args) => {
    const descriptor = fs.openSync(...args);
    if (args[0] === source) sourceDescriptor = descriptor;
    return descriptor;
  }, closeSync: descriptor => {
    fs.closeSync(descriptor);
    // Windows refuses replacing this file while its read descriptor is open.
    // Replace immediately after close, before the final path/identity check.
    if (!replaced && descriptor === sourceDescriptor) {
      replaced = true;
      const previous = fs.statSync(source), temporary = source + '.tmp';
      fs.copyFileSync(source, temporary); fs.utimesSync(temporary, previous.atime, previous.mtime);
      fs.renameSync(temporary, source);
    }
  } });
  assert.throws(() => io.capture(root, ['example'], path.join(root, 'backup')), { code: 'LIBRARY_HISTORY_CONFLICT' });
  assert.equal(fs.readFileSync(source, 'utf8'), 'same source bytes');
});

test('source edits with an unchanged size and restored mtime are detected on the next operation', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-history-edit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, 'node_modules', 'example');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(library, 'package.json'), '{"name":"example"}');
  const source = path.join(library, 'test.h'); fs.writeFileSync(source, 'initial');
  const history = new LibraryHistory(), first = await history.begin(root, ['example']);
  t.after(() => history.discard(root, first.token));
  const old = fs.statSync(source); fs.writeFileSync(source, 'changed'); fs.utimesSync(source, old.atime, old.mtime);
  const second = await history.begin(root, ['example']);
  t.after(() => history.discard(root, second.token));
  assert.notEqual(history.get(root, first.token).before.sources[0].hash, history.get(root, second.token).before.sources[0].hash);
  const snapshot = history.get(root, second.token).before;
  fs.writeFileSync(source, 'later content');
  await history.restoreSources(root, snapshot, snapshot, true);
  assert.equal(fs.readFileSync(source, 'utf8'), 'changed');
});

test('unchanged library backups are shared, survive earlier-step discard and stay isolated from user edits', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-history-shared-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = 'example', library = path.join(root, 'node_modules', name);
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { [name]: '1.0.0' } }));
  fs.writeFileSync(path.join(library, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  const source = path.join(library, 'example.h');
  fs.writeFileSync(source, 'original source');
  const history = new LibraryHistory();
  const first = await history.begin(root, [name]);
  const second = await history.begin(root, [name]);
  t.after(() => history.entries.has(second.token) && history.discard(root, second.token));
  const firstCopy = history.get(root, first.token).before.sources[0].copy;
  assert.equal(history.get(root, second.token).before.sources[0].copy, firstCopy);
  fs.writeFileSync(source, 'new package version');
  assert.equal(fs.statSync(firstCopy).isFile(), true, 'checkpoint stores one file rather than a duplicate source tree');
  await history.commit(root, second.token);
  await history.discard(root, first.token);
  assert.equal(fs.existsSync(firstCopy), true);
  const { target, expected } = await history.prepare(root, second.token, false);
  await history.restoreSources(root, target, expected, true);
  assert.equal(fs.readFileSync(source, 'utf8'), 'original source');
  await history.discard(root, second.token);
  assert.equal(fs.existsSync(firstCopy), false);
});

test('packed checkpoints restore binary files and empty directories; damaged backups never replace current sources', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-history-packed-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, 'node_modules', 'example');
  fs.mkdirSync(path.join(library, 'empty'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(library, 'package.json'), '{"name":"example"}');
  const content = Buffer.alloc(150003, 219), source = path.join(library, 'font.bin');
  fs.writeFileSync(source, content);
  const history = new LibraryHistory(), { token } = await history.begin(root, ['example']);
  t.after(() => history.discard(root, token));
  const target = history.get(root, token).before, copy = target.sources[0].copy;
  const original = fs.readFileSync(copy);
  fs.writeFileSync(source, 'current');
  for (const damaged of [original.subarray(0, original.length - 1), Buffer.concat([original, Buffer.from('extra')]), Buffer.from(original)]) {
    if (damaged.length === original.length) damaged[damaged.length - 10] ^= 1;
    fs.writeFileSync(copy, damaged);
    await assert.rejects(history.restoreSources(root, target, target, true), { code: 'LIBRARY_HISTORY_CONFLICT' });
    assert.equal(fs.readFileSync(source, 'utf8'), 'current');
  }
  fs.writeFileSync(copy, original);
  await history.restoreSources(root, target, target, true);
  assert.deepEqual(fs.readFileSync(source), content);
  assert.deepEqual(fs.readdirSync(path.join(library, 'empty')), []);
});

test('packed checkpoint path traversal is rejected before publishing any source', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-history-packed-path-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, 'node_modules', 'example');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(library, 'package.json'), '{"name":"example"}');
  const history = new LibraryHistory(), { token } = await history.begin(root, ['example']);
  t.after(() => history.discard(root, token));
  const target = history.get(root, token).before, copy = target.sources[0].copy;
  for (const key of ['/../escaped', ...(process.platform === 'win32' ? ['/.. /escaped'] : [])]) {
    const header = Buffer.from(JSON.stringify({ key, directory: false, size: 0, mode: 0o644 }));
    const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
    fs.writeFileSync(copy, Buffer.concat([Buffer.from('AILYLIB1\n'), length, header, Buffer.alloc(4)]));
    await assert.rejects(history.restoreSources(root, target, target, true), { code: 'LIBRARY_HISTORY_CONFLICT' });
  }
  assert.equal(fs.existsSync(path.join(root, 'node_modules', 'escaped')), false);
  assert.equal(fs.readFileSync(path.join(library, 'package.json'), 'utf8'), '{"name":"example"}');
});
