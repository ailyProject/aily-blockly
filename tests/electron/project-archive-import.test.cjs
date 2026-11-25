const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { crc32, deflateRawSync } = require('node:zlib');
const { importProjectArchive } = require('../../electron/project-archive-import');

function makeZip(entries) {
  const local = [], central = [];
  let offset = 0, centralSize = 0;
  for (const { name, value = '', macMode, deflated = false, corrupt = false } of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(value);
    const payload = deflated ? deflateRawSync(data) : data;
    const crc = corrupt ? (crc32(data) + 1) >>> 0 : crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); // UTF-8 paths on both platforms.
    header.writeUInt16LE(deflated ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, payload);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(macMode ? 0x314 : 20, 4);
    header.copy(entry, 6, 4, 14);
    header.copy(entry, 16, 14, 28);
    if (macMode) entry.writeUInt32LE((macMode << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    centralSize += entry.length + filename.length;
    offset += header.length + filename.length + payload.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function fixture(t, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-project-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'Share.ZIP');
  const original = makeZip(entries);
  fs.writeFileSync(archive, original);
  return { root, archive, original, target: path.join(root, '项目副本') };
}

for (const sender of ['Windows', 'macOS']) test(`imports a ${sender} project ZIP with a copied legacy view lock`, async t => {
  const wrapper = sender === 'macOS' ? '项目资料/' : '';
  const execPath = sender === 'macOS' ? '/Applications/aily blockly.app/Contents/MacOS/aily blockly' : 'D:\\aily blockly\\aily blockly.exe';
  const f = fixture(t, [
    { name: `${wrapper}package.json`, value: '{"name":"fixture"}' },
    { name: `${wrapper}project.abi`, value: 'original blocks', deflated: true, macMode: sender === 'macOS' ? 0o100644 : undefined },
    { name: `${wrapper}.aily/project-open.lock`, value: JSON.stringify({ execPath, pid: 123 }) },
    { name: `${wrapper}.aily/project-view.guard` },
    { name: `${wrapper}.aily/.project-open.lock.663bf7cb-4465-4584-b535-270ae054117e.tmp`, value: 'transaction' },
    { name: `${wrapper}.aily/build-executions/run/project.abi`, value: 'temporary' },
    { name: `${wrapper}.aily/abs-sync/committed.json`, value: 'original ABS state' },
    ...(wrapper ? [
      { name: '__MACOSX/项目资料/._project.abi', value: 'Finder metadata' },
      { name: '.DS_Store', value: 'Finder metadata' },
      { name: `${wrapper}node_modules/private-library`, macMode: 0o120777, value: '../local-libraries/private-library' },
      { name: `${wrapper}local-libraries/private-library/package.json`, value: '{}' },
    ] : []),
  ]);
  assert.equal(await importProjectArchive(f.archive, f.target), f.target);
  assert.deepEqual(fs.readFileSync(f.archive), f.original);
  assert.equal(fs.readFileSync(path.join(f.target, 'project.abi'), 'utf8'), 'original blocks');
  assert.deepEqual(fs.readdirSync(path.join(f.target, '.aily')), ['abs-sync']);
  assert.equal(fs.readFileSync(path.join(f.target, '.aily/abs-sync/committed.json'), 'utf8'), 'original ABS state');
  if (wrapper) assert.equal(fs.existsSync(path.join(f.target, 'local-libraries/private-library/package.json')), true);
  assert.equal(fs.existsSync(path.join(f.target, 'node_modules/private-library')), false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['Share.ZIP', '项目副本'].sort());
});

test('imports a ZIP with the Windows tar relative root prefix', async t => {
  const f = fixture(t, [
    { name: './' },
    { name: './package.json', value: '{}' },
    { name: './project.abi', value: 'workspace' },
    { name: './.aily/project-open.lock', value: 'legacy lock' },
  ]);
  await importProjectArchive(f.archive, f.target);
  assert.equal(fs.readFileSync(path.join(f.target, 'project.abi'), 'utf8'), 'workspace');
  assert.equal(fs.existsSync(path.join(f.target, '.aily/project-open.lock')), false);
});

for (const [entry, message] of [
  [{ name: 'project.abi', value: 'damaged', corrupt: true }, /checksum/],
  [{ name: 'PACKAGE.JSON', value: 'conflict' }, /conflicting/],
  [{ name: './package.json', value: 'conflict' }, /conflicting/],
  [{ name: '././project.abi', value: 'invalid path' }, /invalid entry path/],
  [{ name: 'assets/../project.abi', value: 'invalid path' }, /invalid relative path/],
  [{ name: 'assets/link', value: 'unavailable target', macMode: 0o120777 }, /linked or special/],
]) test(`failed archive import retains the ZIP and avoids a partial project (${entry.name})`, async t => {
  const f = fixture(t, [{ name: 'package.json', value: '{}' }, entry]);
  await assert.rejects(importProjectArchive(f.archive, f.target), message);
  assert.deepEqual(fs.readFileSync(f.archive), f.original);
  assert.deepEqual(fs.readdirSync(f.root), ['Share.ZIP']);
});

test('publishes the staged project via same-volume moves, with the manifest last', async t => {
  const data = Buffer.alloc(8 * 1024 ** 2, 0x74);
  const f = fixture(t, [{ name: 'package.json', value: '{}' }, { name: 'project.abi', value: data, deflated: true }]);
  const rename = fs.renameSync, order = [];
  t.mock.method(fs, 'cpSync', () => assert.fail('ZIP publication must not copy staged files'));
  t.mock.method(fs, 'renameSync', (source, target) => {
    const staged = fs.statSync(source, { bigint: true });
    assert.equal(fs.existsSync(path.join(f.target, 'package.json')), false);
    rename(source, target);
    const published = fs.statSync(target, { bigint: true });
    assert.equal(published.ino, staged.ino);
    assert.equal(published.dev, staged.dev);
    order.push(path.basename(target));
  });
  assert.equal(await importProjectArchive(f.archive, f.target), f.target);
  assert.deepEqual(order, ['project.abi', 'package.json']);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'project.abi')), data);
});

test('a move failure removes the partial project and allows a fresh retry', async t => {
  const f = fixture(t, [{ name: 'package.json', value: '{}' }, { name: 'project.abi', value: 'project content' }]);
  const rename = fs.renameSync;
  const publication = t.mock.method(fs, 'renameSync', (source, target) => {
    if (path.basename(target) === 'package.json') throw new Error('simulated publication failure');
    rename(source, target);
  });
  await assert.rejects(importProjectArchive(f.archive, f.target), /simulated publication failure/);
  assert.deepEqual(fs.readdirSync(f.root), ['Share.ZIP']);
  assert.deepEqual(fs.readFileSync(f.archive), f.original);
  publication.mock.restore();
  assert.equal(await importProjectArchive(f.archive, f.target), f.target);
});

test('a ZIP import never replaces an existing project directory', async t => {
  const f = fixture(t, [{ name: 'package.json', value: '{}' }]);
  fs.mkdirSync(f.target);
  fs.writeFileSync(path.join(f.target, 'keep'), 'original destination');
  await assert.rejects(importProjectArchive(f.archive, f.target), { code: 'EEXIST' });
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['Share.ZIP', '项目副本'].sort());
  assert.equal(fs.readFileSync(path.join(f.target, 'keep'), 'utf8'), 'original destination');
});
