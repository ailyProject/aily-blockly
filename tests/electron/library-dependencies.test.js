const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LibraryDependencies, runDependencyWorker } = require('../../electron/library-dependencies');
const { LibraryDependencySessions } = require('../../electron/library-dependency-sessions');

test('clean reconciliation is fast only for Coder; Blockly, unknown, dirty and history-restored projects keep npm recovery', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-reconcile-mode-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const api = new LibraryDependencies({ run: async (_root, request) => {
    requests.push(request);
    return { manifest: api.read(root) };
  } });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mode-test' }));
  const check = async (expected, options = {}) => {
    await api.discard(root, { reconcile: true, ...options });
    assert.equal(requests.at(-1).reconcileOnly, expected);
  };
  await check(false);
  fs.writeFileSync(path.join(root, 'project.aci'), '');
  await check(true);
  fs.writeFileSync(path.join(root, 'project.abi'), '{}');
  await check(false);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mode-test', type: 'coder' }));
  await check(true);
  await check(false, { historyRestored: true });
  await api.patch(root, { nickname: 'unsaved metadata' });
  await check(false);
  await check(true);
});

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-library-save-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['a', 'b', 'c', 'd', 'c2']) {
    const dir = path.join(root, 'local-libraries', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `test-${name === 'c2' ? 'c' : name}`, version: name === 'c2' ? '2.0.0' : '1.0.0' }));
  }
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const write = (file, data) => fs.writeFileSync(path.join(root, file), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  write('package.json', { name: 'library-save-test', version: '1.0.0', dependencies: { 'test-a': 'file:local-libraries/a', 'test-b': 'file:local-libraries/b' } });
  await runDependencyWorker(root, { save: true });
  await runDependencyWorker(root, {});
  const installed = () => fs.readdirSync(path.join(root, 'node_modules')).filter(name => !name.startsWith('.')).sort();
  const api = new LibraryDependencies({ trashLocalDirectory: target => fs.promises.rm(target, { recursive: true }) });
  const install = name => api.mutate(root, { action: 'install', packages: [`test-${name === 'c2' ? 'c' : name}@file:local-libraries/${name}`] });
  const remove = name => api.mutate(root, { action: 'remove', packages: [`test-${name}`] });
  return { root, read, write, installed, api, install, remove };
}

test('Coder source preparation holds saves, and a failed operation restores the previous unsaved tree', async t => {
  const f = await fixture(t), sessions = new LibraryDependencySessions(f.api);
  await f.install('c');
  const baseline = f.read('package.json');
  const { transaction } = await sessions.run('begin', f.root);
  await sessions.run('mutate', f.root, { action: 'remove', packages: ['test-b'] }, transaction);
  assert.equal((await sessions.run('status', f.root)).busy, true);
  let saved = false;
  const saving = sessions.run('save', f.root).then(() => { saved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved, false);
  assert.equal(f.read('package.json'), baseline);
  await sessions.run('abort', f.root, undefined, transaction);
  await saving;
  assert.deepEqual(f.installed(), ['test-a', 'test-b', 'test-c']);
  assert.equal(f.api.status(f.root).dirty, false);
  assert.deepEqual(Object.keys(JSON.parse(f.read('package.json')).dependencies).sort(), ['test-a', 'test-b', 'test-c']);
  await assert.rejects(sessions.run('mutate', f.root, { action: 'remove', packages: ['test-a'] }, transaction), /expired/);
});

test('local and legacy Coder library removal restores bytes without draft directories', async t => {
  const f = await fixture(t), sessions = new LibraryDependencySessions(f.api);
  const directory = name => path.join(f.root, 'sketch/libraries', name);
  for (const name of ['UserLibrary', 'LegacyLibrary']) {
    fs.mkdirSync(path.join(directory(name), 'src'), { recursive: true });
    fs.writeFileSync(path.join(directory(name), 'src/data.bin'), Buffer.from([0, 255, 17]));
    fs.writeFileSync(path.join(directory(name), 'library.properties'), `name=${name}\nversion=1.0.0`);
  }
  const disk = f.read('package.json'), lock = f.read('package-lock.json');
  await sessions.run('removeLocal', f.root, { folderName: 'UserLibrary' });
  assert.equal(f.api.status(f.root).dirty, true);
  await assert.rejects(sessions.run('begin', f.root, { requireClean: true }), /LIBRARY_CHANGES_UNSAVED/);
  const { transaction } = await sessions.run('begin', f.root);
  await sessions.run('removeLocal', f.root, { folderName: 'LegacyLibrary' }, transaction);
  await sessions.run('abort', f.root, undefined, transaction);
  assert.equal(fs.existsSync(directory('UserLibrary')), false);
  assert.equal(fs.existsSync(directory('LegacyLibrary')), true);
  await f.api.discard(f.root, { reconcile: true });
  assert.deepEqual(fs.readFileSync(path.join(directory('UserLibrary'), 'src/data.bin')), Buffer.from([0, 255, 17]));
  assert.equal(f.api.status(f.root).dirty, false);
  await f.api.removeLocal(f.root, { folderName: 'LegacyLibrary' });
  await f.api.save(f.root);
  await f.api.discard(f.root, { reconcile: true });
  assert.equal(fs.existsSync(directory('LegacyLibrary')), false);
  assert.equal(f.read('package.json'), disk);
  assert.equal(f.read('package-lock.json'), lock);
  assert.equal(fs.existsSync(path.join(f.root, '.temp')), false);
  await assert.rejects(f.api.removeLocal(f.root, { folderName: '../UserLibrary' }), /Invalid/);
  fs.symlinkSync(directory('UserLibrary'), directory('LinkedLibrary'), 'dir');
  await assert.rejects(f.api.removeLocal(f.root, { folderName: 'LinkedLibrary' }), /links/);
  assert.equal(fs.existsSync(directory('UserLibrary')), true);
});

test('Coder metadata-only edit and expired child transaction can be discarded without manifest backups', async t => {
  const f = await fixture(t), sessions = new LibraryDependencySessions(f.api, { timeoutMs: 80 });
  const baseline = f.read('package.json');
  const { transaction } = await sessions.run('begin', f.root);
  await sessions.run('patch', f.root, { coderBoardTemplateDependencies: { schemaVersion: 1, dependencies: {} } }, transaction);
  assert.equal(f.api.status(f.root).dirty, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  // Abort waits for real npm reconciliation; a later discard waits for that too.
  await sessions.run('discard', f.root);
  assert.equal(f.api.status(f.root).dirty, false);
  assert.equal(f.read('package.json'), baseline);
});

test('real npm: cumulative installs/removals, save, discard and no draft files', async t => {
  const f = await fixture(t), { root, api } = f;
  assert.notEqual((await runDependencyWorker(root, { reconcileOnly: true })).unchanged, true, 'local sources must still use npm reconciliation');
  const before = ['package.json', 'package-lock.json'].map(f.read);
  for (const [operation, expected] of [
    [() => f.remove('b'), ['test-a']],
    [() => f.install('c'), ['test-a', 'test-c']],
    [() => f.install('d'), ['test-a', 'test-c', 'test-d']],
    [() => f.install('c2'), ['test-a', 'test-c', 'test-d']],
    [() => f.remove('d'), ['test-a', 'test-c']],
  ]) {
    await operation();
    assert.deepEqual(f.installed(), expected);
    assert.deepEqual(['package.json', 'package-lock.json'].map(f.read), before);
    assert.equal(api.status(root).dirty, true);
  }
  assert.equal(JSON.parse(f.read('node_modules/test-c/package.json')).version, '2.0.0');
  await api.save(root);
  const saved = JSON.parse(f.read('package.json'));
  assert.deepEqual(saved.dependencies, { 'test-a': 'file:local-libraries/a', 'test-c': 'file:local-libraries/c2' });
  assert.deepEqual(JSON.parse(f.read('package-lock.json')).packages[''].dependencies, saved.dependencies);
  assert.equal(api.status(root).dirty, false);
  const snapshot = ['package.json', 'package-lock.json'].map(f.read);
  await f.remove('c'); await f.install('b'); await f.install('d');
  await api.discard(root);
  assert.deepEqual(f.installed(), ['test-a', 'test-c']);
  assert.deepEqual(['package.json', 'package-lock.json'].map(f.read), snapshot);
  assert.equal(api.status(root).dirty, false);
  assert.deepEqual(fs.readdirSync(root).sort(), ['.aily', 'local-libraries', 'node_modules', 'package-lock.json', 'package.json']);
  assert.deepEqual(fs.readdirSync(path.join(root, '.aily')), []);
});

test('discard follows current disk after Chat restore; save preserves unrelated external metadata', async t => {
  const f = await fixture(t);
  await f.install('c');
  f.write('package.json', { ...JSON.parse(f.read('package.json')), description: 'external edit' });
  await f.api.save(f.root);
  assert.equal(JSON.parse(f.read('package.json')).description, 'external edit');
  await f.remove('a');
  const restored = { name: 'restored-chat-version', dependencies: { 'test-d': 'file:local-libraries/d' } };
  f.write('package.json', restored);
  await f.api.discard(f.root);
  assert.deepEqual(JSON.parse(f.read('package.json')), restored);
  assert.deepEqual(f.installed(), ['test-d']);
});

test('failed real install restores the preceding unsaved tree and does not write root files', async t => {
  const f = await fixture(t);
  await f.remove('b'); await f.install('c');
  const before = ['package.json', 'package-lock.json'].map(f.read);
  await assert.rejects(f.api.mutate(f.root, { action: 'install', packages: ['missing@file:./does-not-exist'] }));
  assert.deepEqual(f.installed(), ['test-a', 'test-c']);
  assert.deepEqual(['package.json', 'package-lock.json'].map(f.read), before);
  await f.api.discard(f.root);
  assert.deepEqual(f.installed(), ['test-a', 'test-b']);
});

test('concurrent requests serialize and package metadata waits for save', async t => {
  const f = await fixture(t);
  await Promise.all([f.install('c'), f.remove('b'), f.install('d')]);
  await f.api.patch(f.root, { blocklyToolboxOrder: ['test-d', 'test-c'] });
  assert.equal(JSON.parse(f.read('package.json')).blocklyToolboxOrder, undefined);
  assert.deepEqual(f.installed(), ['test-a', 'test-c', 'test-d']);
  await f.api.save(f.root);
  assert.deepEqual(JSON.parse(f.read('package.json')).blocklyToolboxOrder, ['test-d', 'test-c']);
});

test('real registry resolution pins pending versions, retains transitives and saves without reinstalling', async t => {
  const f = await fixture(t);
  const http = require('node:http');
  const crypto = require('node:crypto');
  const npmRoot = path.join(process.env.AILY_CHILD_PATH || path.join(__dirname, '../../child'), 'node', process.platform === 'win32' ? 'node_modules/npm' : 'lib/node_modules/npm');
  const tar = require(path.join(npmRoot, 'node_modules/tar'));
  const artifacts = new Map();
  for (const [name, version, dependencies] of [['registry-a', '1.0.0', { 'registry-transitive': '^1.0.0' }], ['registry-b', '1.0.0', {}], ['registry-transitive', '1.0.0', {}]]) {
    const directory = path.join(f.root, 'registry', name);
    fs.mkdirSync(path.join(directory, 'package'), { recursive: true });
    const manifest = { name, version, dependencies };
    fs.writeFileSync(path.join(directory, 'package/package.json'), JSON.stringify(manifest));
    const file = path.join(directory, 'package.tgz');
    await tar.c({ gzip: true, file, cwd: directory }, ['package']);
    const body = fs.readFileSync(file);
    artifacts.set(name, { manifest, body, integrity: `sha512-${crypto.createHash('sha512').update(body).digest('base64')}` });
  }
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    const name = request.url.split('/')[1], pkg = artifacts.get(name);
    if (!pkg) { response.writeHead(404); response.end(); return; }
    if (request.url.endsWith('.tgz')) { response.end(pkg.body); return; }
    const version = { ...pkg.manifest, dist: { tarball: `http://127.0.0.1:${server.address().port}/${name}/package.tgz`, integrity: pkg.integrity } };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name, 'dist-tags': { latest: version.version }, versions: { [version.version]: version } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { registry: `http://127.0.0.1:${server.address().port}`, fetchRetries: 0 };
  const before = ['package.json', 'package-lock.json'].map(f.read);
  await f.api.mutate(f.root, { action: 'install', packages: ['registry-a@latest'], options });
  await f.api.mutate(f.root, { action: 'install', packages: ['registry-b@^1.0.0'], options });
  assert.equal(f.api.status(f.root).manifest.dependencies['registry-a'], '1.0.0');
  assert.equal(f.api.status(f.root).manifest.dependencies['registry-b'], '1.0.0');
  assert.ok(f.installed().includes('registry-transitive'));
  assert.deepEqual(['package.json', 'package-lock.json'].map(f.read), before);
  const installedManifest = path.join(f.root, 'node_modules/registry-a/package.json');
  const originalInode = fs.statSync(installedManifest).ino;
  await f.api.save(f.root);
  assert.equal(fs.statSync(installedManifest).ino, originalInode, 'save must not reinstall an already active library');
  assert.deepEqual(JSON.parse(f.read('package-lock.json')).packages[''].dependencies, JSON.parse(f.read('package.json')).dependencies);
  // A fresh host has no in-memory edit state. Reopening a consistent registry
  // tree can be read-only, while crash leftovers still require real npm repair.
  // Local file dependencies deliberately retain the conservative npm path.
  const clean = { name: 'registry-reopen', version: '1.0.0', type: 'coder', dependencies: { 'registry-a': '1.0.0', 'registry-b': '^1.0.0' } };
  f.write('package.json', clean);
  fs.rmSync(path.join(f.root, 'node_modules'), { recursive: true });
  fs.unlinkSync(path.join(f.root, 'package-lock.json'));
  await runDependencyWorker(f.root, { options, save: true });
  await runDependencyWorker(f.root, { options });
  const baseline = ['package.json', 'package-lock.json'].map(f.read);
  const requestsBeforeReopen = requests;
  assert.equal((await runDependencyWorker(f.root, { options, reconcileOnly: true })).unchanged, true);
  assert.equal(requests, requestsBeforeReopen, 'a consistent tree must not contact the registry');
  assert.deepEqual(['package.json', 'package-lock.json'].map(f.read), baseline);
  fs.unlinkSync(path.join(f.root, 'package-lock.json'));
  assert.equal((await runDependencyWorker(f.root, { options, reconcileOnly: true })).unchanged, true, 'Coder projects without a root lockfile are checked too');
  const extra = path.join(f.root, 'node_modules/crash-leftover');
  fs.mkdirSync(extra); fs.writeFileSync(path.join(extra, 'package.json'), JSON.stringify({ name: 'crash-leftover', version: '1.0.0' }));
  assert.notEqual((await runDependencyWorker(f.root, { options, reconcileOnly: true })).unchanged, true);
  assert.equal(fs.existsSync(extra), false);
  fs.rmSync(path.join(f.root, 'node_modules/registry-transitive'), { recursive: true });
  assert.notEqual((await runDependencyWorker(f.root, { options, reconcileOnly: true })).unchanged, true);
  assert.equal(JSON.parse(f.read('node_modules/registry-transitive/package.json')).version, '1.0.0');
  // A stale hidden lockfile must not hide metadata edited in place.
  const manifestPath = path.join(f.root, 'node_modules/registry-a/package.json');
  const original = fs.readFileSync(manifestPath, 'utf8');
  fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(original), version: '0.0.1' }));
  assert.notEqual((await runDependencyWorker(f.root, { options, reconcileOnly: true })).unchanged, true);
  fs.writeFileSync(manifestPath, original);
  // Even a clean actual tree must honor a restored saved manifest's removals.
  f.write('package.json', { ...clean, dependencies: { 'registry-b': '^1.0.0' } });
  const fresh = new LibraryDependencies();
  await fresh.discard(f.root, { reconcile: true });
  assert.deepEqual(f.installed(), ['registry-b']);
});
