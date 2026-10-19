const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { importProjectPackage } = require('./project-package-import');
const { MAX_PROJECT_FILE_BYTES } = require('./project-file-access');

const sevenZipPath = process.env.AILY_7ZA_PATH;
// Exercise the internal parser without exposing a production API solely for tests.
const source = fs.readFileSync(path.join(__dirname, 'project-package-import.js'), 'utf8');
const { parseArchiveListing, validateProject } = vm.runInNewContext(source + '\n({ parseArchiveListing, validateProject })', { require, module: { exports: {} } });

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-package-import-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('project-package-import-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fixture(t, product, { wrapper = false, update = () => {} } = {}) {
  const root = temporaryDirectory(t);
  const archiveRoot = path.join(root, 'source');
  const source = wrapper ? path.join(archiveRoot, 'wrapper') : archiveRoot;
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', type: product, cloudId: 'upstream',
    ...(product === 'coder' ? { entry: 'src/main.cpp' } : {}) }));
  if (product === 'coder') {
    fs.mkdirSync(path.join(source, 'sketch', 'src'), { recursive: true });
    fs.mkdirSync(path.join(source, 'sketch', 'libraries', 'local'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sketch', 'src', 'main.cpp'), 'void setup() {}');
    fs.writeFileSync(path.join(source, 'sketch', 'libraries', 'local', 'library.h'), 'local library');
  } else {
    fs.writeFileSync(path.join(source, 'project.abi'), JSON.stringify({ blocks: { blocks: [] } }));
    fs.mkdirSync(path.join(source, 'data'));
    fs.writeFileSync(path.join(source, 'data', 'asset.bin'), Buffer.from([0, 1, 2, 255]));
  }
  fs.mkdirSync(path.join(source, '.aily', 'abs-sync'), { recursive: true });
  fs.writeFileSync(path.join(source, '.aily', 'abs-sync', 'recovery.json'), '{"recover":true}');
  fs.writeFileSync(path.join(source, '.aily', 'project-open.lock'), 'source owner');
  update(source, archiveRoot);
  const archivePath = path.join(root, 'archive.7z');
  execFileSync(sevenZipPath, ['a', '-t7z', archivePath, '.'], { cwd: archiveRoot, windowsHide: true, stdio: 'ignore' });
  return { root, source, options: { archivePath, destination: path.join(root, 'projects', 'imported'), product, sevenZipPath, tempRoot: root } };
}

function assertTemporaryFilesRemoved(root) {
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('aily-project-import-')), false);
}

test('archive directory rejects unsafe paths, links, encryption, aliases and resource limits', () => {
  const listing = (name, extra = '') => `Path = ${name}\nSize = 10\nAttributes = A\nEncrypted = -${extra}\n\n`;
  for (const name of ['../escape', '/escape', 'C:/escape', 'folder\\..\\escape', 'folder/../escape', 'NUL.txt', 'file:stream']) {
    assert.throws(() => parseArchiveListing(listing(name)));
  }
  for (const field of ['Symbolic Link = ../escape', 'Hard Link = file']) {
    assert.throws(() => parseArchiveListing(listing('link', `\n${field}`)));
  }
  assert.throws(() => parseArchiveListing(listing('encrypted').replace('Encrypted = -', 'Encrypted = +')));
  assert.throws(() => parseArchiveListing(listing('link').replace('Attributes = A', 'Attributes = A lrwxrwxrwx')));
  assert.throws(() => parseArchiveListing('Path = fifo\nSize = 0\nAttributes = A prw-------\n'));
  assert.throws(() => parseArchiveListing(listing('file') + listing('FILE')));
  assert.throws(() => parseArchiveListing(listing('file') + listing('file/child')));
  assert.throws(() => parseArchiveListing('Path = large\nSize = 524288001\nAttributes = A\n'));
  assert.throws(() => parseArchiveListing(Array.from({ length: 10001 }, (_, index) => listing(`f${index}`)).join('')));
  assert.equal(JSON.stringify(parseArchiveListing(listing('data\\resource.bin'))),
    JSON.stringify([{ name: 'data/resource.bin', size: 10, directory: false }]));
});

for (const product of ['blockly', 'coder']) {
  test(`real 7z ${product} package imports a new copy with resources and no cloud ownership`, { skip: !sevenZipPath }, async t => {
    const f = fixture(t, product, { wrapper: product === 'coder' });
    const originalArchive = fs.readFileSync(f.options.archivePath);
    const originalManifest = fs.readFileSync(path.join(f.source, 'package.json'));
    const result = await importProjectPackage(f.options);
    assert.equal(result, f.options.destination);
    assert.equal(JSON.parse(fs.readFileSync(path.join(result, 'package.json'), 'utf8')).cloudId, undefined);
    assert.deepEqual(fs.readFileSync(path.join(f.source, 'package.json')), originalManifest);
    assert.deepEqual(fs.readFileSync(f.options.archivePath), originalArchive);
    assert.equal(fs.readFileSync(path.join(result, '.aily', 'abs-sync', 'recovery.json'), 'utf8'), '{"recover":true}');
    assert.equal(fs.existsSync(path.join(result, '.aily', 'project-open.lock')), false);
    assert.equal(fs.readFileSync(path.join(f.source, '.aily', 'project-open.lock'), 'utf8'), 'source owner');
    if (product === 'coder') assert.equal(fs.readFileSync(path.join(result, 'sketch/libraries/local/library.h'), 'utf8'), 'local library');
    else assert.deepEqual(fs.readFileSync(path.join(result, 'data/asset.bin')), Buffer.from([0, 1, 2, 255]));
    assertTemporaryFilesRemoved(f.root);
  });
}

test('Blockly ABI is bounded by the existing project file limit before JSON reading', t => {
  const root = temporaryDirectory(t);
  const manifest = '{"type":"blockly","cloudId":"upstream"}';
  fs.writeFileSync(path.join(root, 'package.json'), manifest);
  const descriptor = fs.openSync(path.join(root, 'project.abi'), 'wx');
  try { fs.ftruncateSync(descriptor, MAX_PROJECT_FILE_BYTES + 1); } finally { fs.closeSync(descriptor); }
  assert.throws(() => validateProject(root, 'blockly'), /文件过大/);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), manifest);
});

test('relative paths, unsupported products, invalid headers and oversized archives fail before installing', async t => {
  const root = temporaryDirectory(t);
  const archivePath = path.join(root, 'archive.7z');
  const destination = path.join(root, 'projects', 'imported');
  fs.writeFileSync(archivePath, 'invalid archive');
  const options = { archivePath, destination, product: 'blockly', sevenZipPath, tempRoot: root };
  await assert.rejects(importProjectPackage({ ...options, archivePath: 'relative.7z' }), /参数/);
  await assert.rejects(importProjectPackage({ ...options, destination: 'relative' }), /参数/);
  await assert.rejects(importProjectPackage({ ...options, product: 'other' }), /参数/);
  await assert.rejects(importProjectPackage(options), /不是 7z/);
  const descriptor = fs.openSync(archivePath, 'w');
  try { fs.ftruncateSync(descriptor, 100 * 1024 * 1024 + 1); } finally { fs.closeSync(descriptor); }
  await assert.rejects(importProjectPackage(options), /大小/);
  assert.equal(fs.existsSync(path.dirname(destination)), false);
  assertTemporaryFilesRemoved(root);
});

test('invalid project structure, JSON, product and Coder entry never create a destination', { skip: !sevenZipPath }, async t => {
  const cases = [
    ['blockly', source => fs.unlinkSync(path.join(source, 'package.json'))],
    ['blockly', source => fs.writeFileSync(path.join(source, 'project.abi'), 'invalid JSON')],
    ['blockly', source => fs.writeFileSync(path.join(source, 'package.json'), '{"type":"coder"}')],
    ['coder', source => fs.writeFileSync(path.join(source, 'package.json'), '{"type":"coder","entry":"../main.cpp"}')],
    ['coder', source => fs.unlinkSync(path.join(source, 'sketch', 'src', 'main.cpp'))],
  ];
  for (const [product, update] of cases) {
    const f = fixture(t, product, { update });
    await assert.rejects(importProjectPackage(f.options));
    assert.equal(fs.existsSync(path.dirname(f.options.destination)), false);
    assertTemporaryFilesRemoved(f.root);
  }
});

test('existing targets are preserved when an import destination already exists', { skip: !sevenZipPath }, async t => {
  const f = fixture(t, 'blockly');
  fs.mkdirSync(f.options.destination, { recursive: true });
  fs.writeFileSync(path.join(f.options.destination, 'keep'), 'keep');
  await assert.rejects(importProjectPackage(f.options), { code: 'EEXIST' });
  assert.deepEqual(fs.readdirSync(f.options.destination), ['keep']);
  assert.equal(fs.readFileSync(path.join(f.options.destination, 'keep'), 'utf8'), 'keep');
  assertTemporaryFilesRemoved(f.root);
});
