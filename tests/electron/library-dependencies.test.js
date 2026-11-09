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

test('public library operations persist manifest and lockfile before returning and survive discard/reopen', async t => {
  const f = await fixture(t), sessions = new LibraryDependencySessions(f.api);
  for (const request of [
    { action: 'remove', packages: ['test-b'] },
    { action: 'install', packages: ['test-c@file:local-libraries/c'] },
    { action: 'install', packages: ['test-d@file:local-libraries/d'] },
  ]) {
    const status = await sessions.run('mutate', f.root, request);
    assert.equal(status.dirty, false);
    assert.deepEqual(JSON.parse(f.read('package.json')).dependencies,
      JSON.parse(f.read('package-lock.json')).packages[''].dependencies);
  }
  const baseline = ['package.json', 'package-lock.json'].map(f.read);
  await sessions.run('discard', f.root);
  await new LibraryDependencies().discard(f.root, { reconcile: true });
  assert.deepEqual(f.installed(), ['test-a', 'test-c', 'test-d']);
  assert.deepEqual(['package.json', 'package-lock.json'].map(f.read), baseline);
});

test('automatic library save preserves build fingerprints refreshed during npm and source preparation', async t => {
  const f = await fixture(t), sessions = new LibraryDependencySessions(f.api), run = f.api.run;
  let revision = 0;
  f.api.run = async (root, request) => {
    const result = await run(root, request);
    if (!request.save) f.write('package.json', { ...JSON.parse(f.read('package.json')),
      codeHash: `build-${++revision}`, buildInfo: { lastBuildCode: `build-${revision}` } });
    return result;
  };
  await sessions.run('mutate', f.root, { action: 'install', packages: ['test-c@file:local-libraries/c'] });
  const saved = JSON.parse(f.read('package.json'));
  assert.equal(revision, 2);
  assert.equal(saved.codeHash, 'build-2');
  assert.deepEqual(saved.buildInfo, { lastBuildCode: 'build-2' });
  assert.ok(saved.dependencies['test-c']);
  assert.deepEqual(JSON.parse(f.read('package-lock.json')).packages[''].dependencies, saved.dependencies);
  assert.equal(f.api.status(f.root).dirty, false);
});

test('automatic source preparation expands root/nested archives and transitives, preserves edits and rejects bad archives', async t => {
  const f = await fixture(t), sessions = new LibraryDependencySessions(f.api);
  const { execFileSync } = require('node:child_process');
  const extractor = path.resolve(__dirname, '../../child', process.platform === 'win32' ? '7za.exe' : '7zz');
  for (const [folder, nested] of [['archive', false], ['nested', true], ['bad', false], ['empty', true]]) {
    const directory = path.join(f.root, 'local-libraries', folder);
    const input = path.join(f.root, `archive-input-${folder}`, ...(nested ? ['src'] : []));
    fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(input, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: `@aily-project/lib-${folder}`, version: '1.0.0',
      ...(folder === 'archive' ? { dependencies: { '@aily-project/lib-nested': 'file:../nested' } } : {}) }));
    if (folder !== 'empty') fs.writeFileSync(path.join(input, 'Fixture.h'), `// ${folder}\n`);
    execFileSync(extractor, ['a', '-t7z', path.join(directory, 'src.7z'), '.'], {
      cwd: path.join(f.root, `archive-input-${folder}`), stdio: 'pipe',
    });
    if (folder === 'bad') fs.writeFileSync(path.join(directory, 'src.7z'), 'invalid archive');
  }
  const install = folder => sessions.run('mutate', f.root, { action: 'install',
    packages: [`@aily-project/lib-${folder}@file:local-libraries/${folder}`], options: { installLinks: false } });
  await install('archive');
  const source = name => path.join(f.root, 'node_modules', `@aily-project/lib-${name}`, 'src/Fixture.h');
  assert.equal(fs.readFileSync(source('archive'), 'utf8'), '// archive\n');
  assert.equal(fs.readFileSync(source('nested'), 'utf8'), '// nested\n');
  // R2 source expansion owns the same physical lock. Production startup does
  // not nest that lock; a competing writer must finish before any extraction.
  fs.rmSync(path.dirname(source('archive')), { recursive: true });
  const { createProjectFileAccess, acquireProjectFileLock } = require('../../electron/project-file-access');
  const lock = await acquireProjectFileLock(createProjectFileAccess(f.root, f.root), () => {});
  const preparing = sessions.run('prepare', f.root);
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(source('archive')), false, 'No source write may bypass a live native writer');
  } finally { lock.release(); }
  await preparing;
  assert.equal(fs.readFileSync(source('archive'), 'utf8'), '// archive\n');
  fs.writeFileSync(source('archive'), '// user edit\n');
  const baseline = ['package.json', 'package-lock.json'].map(f.read);
  for (const folder of ['bad', 'empty']) {
    await assert.rejects(install(folder), /解压失败/);
    assert.deepEqual(['package.json', 'package-lock.json'].map(f.read), baseline);
    assert.equal(f.api.status(f.root).dirty, false);
    assert.equal(sessions.sessions.size, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'node_modules', `@aily-project/lib-${folder}`)), false);
    assert.equal(fs.existsSync(path.join(f.root, 'local-libraries', folder, 'src')), false);
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'local-libraries', folder)).filter(name => name.startsWith('.src-extract-')), []);
  }
  assert.equal(fs.readFileSync(source('archive'), 'utf8'), '// user edit\n');
  await sessions.run('mutate', f.root, { action: 'remove', packages: ['@aily-project/lib-archive'] });
  assert.equal(JSON.parse(f.read('package.json')).dependencies['@aily-project/lib-archive'], undefined);
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules/@aily-project/lib-archive')), false);
});

test('Coder transaction commits only at end; failed publication retains recoverable staged state', async t => {
  const f = await fixture(t), sessions = new LibraryDependencySessions(f.api);
  const { transaction } = await sessions.run('begin', f.root);
  const before = f.read('package.json');
  await sessions.run('mutate', f.root, { action: 'remove', packages: ['test-b'] }, transaction);
  assert.equal(f.read('package.json'), before);
  await sessions.run('end', f.root, undefined, transaction);
  assert.equal(JSON.parse(f.read('package.json')).dependencies['test-b'], undefined);
  assert.equal(f.api.status(f.root).dirty, false);
  const run = f.api.run;
  f.api.run = (root, request) => request.save ? Promise.reject(new Error('publication failed')) : run(root, request);
  await assert.rejects(sessions.run('mutate', f.root, { action: 'install', packages: ['test-c@file:local-libraries/c'] }), /publication failed/);
  assert.equal(f.api.status(f.root).dirty, true);
  assert.equal(sessions.sessions.size, 0);
  f.api.run = run;
  await sessions.run('save', f.root);
  assert.equal(f.api.status(f.root).dirty, false);
  assert.ok(JSON.parse(f.read('package.json')).dependencies['test-c']);
});

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
  const staging = await sessions.run('begin', f.root);
  await sessions.run('removeLocal', f.root, { folderName: 'UserLibrary' }, staging.transaction);
  assert.equal(f.api.status(f.root).dirty, true);
  await sessions.run('end', f.root, undefined, staging.transaction);
  assert.equal(f.api.status(f.root).dirty, false);
  const { transaction } = await sessions.run('begin', f.root);
  await sessions.run('removeLocal', f.root, { folderName: 'LegacyLibrary' }, transaction);
  await sessions.run('abort', f.root, undefined, transaction);
  assert.equal(fs.existsSync(directory('UserLibrary')), false);
  assert.equal(fs.existsSync(directory('LegacyLibrary')), true);
  await f.api.discard(f.root, { reconcile: true });
  assert.equal(fs.existsSync(directory('UserLibrary')), false, 'a completed removal is already saved');
  assert.equal(f.api.status(f.root).dirty, false);
  await f.api.removeLocal(f.root, { folderName: 'LegacyLibrary' });
  await f.api.save(f.root);
  await f.api.discard(f.root, { reconcile: true });
  assert.equal(fs.existsSync(directory('LegacyLibrary')), false);
  assert.equal(f.read('package.json'), disk);
  assert.equal(f.read('package-lock.json'), lock);
  assert.equal(fs.existsSync(path.join(f.root, '.temp')), false);
  await assert.rejects(f.api.removeLocal(f.root, { folderName: '../UserLibrary' }), /Invalid/);
  fs.mkdirSync(directory('UserLibrary'), { recursive: true });
  fs.symlinkSync(directory('UserLibrary'), directory('LinkedLibrary'), process.platform === 'win32' ? 'junction' : 'dir');
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
  assert.deepEqual(fs.readdirSync(path.join(root, '.aily')).sort(), ['dependency-recovery', 'project-files.guard']);
  assert.ok(fs.readdirSync(path.join(root, '.aily/dependency-recovery')).every(name => /^environment-[0-9a-f]{64}$/.test(name)),
    'Only checksummed original environment checkpoints are retained; no loose manifest drafts');
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


test('confirmed library undo and redo reinstall exact dependencies and lock, retaining unrelated settings', async t => {
  const f = await fixture(t), sessions = new LibraryDependencySessions(f.api);
  const { token } = await sessions.run('historyBegin', f.root, { packages: ['test-b', 'test-c@file:local-libraries/c'] });
  t.after(() => f.api.history.entries.has(token) && f.api.history.discard(f.root, token));
  const before = f.read('package-lock.json');
  await sessions.run('mutate', f.root, { action: 'remove', packages: ['test-b'] });
  await sessions.run('mutate', f.root, { action: 'install', packages: ['test-c@file:local-libraries/c'] });
  const after = f.read('package-lock.json');
  assert.equal((await sessions.run('historyCommit', f.root, { token })).changed, true);
  f.write('package.json', { ...JSON.parse(f.read('package.json')), nickname: 'retained user setting', codeHash: 'latest-build' });
  for (const forward of [false, true, false, true]) {
    await sessions.run('historyRestore', f.root, { token, forward });
    assert.deepEqual(f.installed(), forward ? ['test-a', 'test-c'] : ['test-a', 'test-b']);
    assert.equal(f.read('package-lock.json'), forward ? after : before);
    assert.equal(JSON.parse(f.read('package.json')).nickname, 'retained user setting');
    assert.equal(JSON.parse(f.read('package.json')).codeHash, 'latest-build');
    assert.equal(f.api.status(f.root).busy, false);
  }
});

test('library undo refuses newer dependency edits and leaves canonical local source edits alone', async t => {
  const f = await fixture(t), sessions = new LibraryDependencySessions(f.api);
  const { token } = await sessions.run('historyBegin', f.root, { packages: ['test-b'] });
  t.after(() => f.api.history.discard(f.root, token));
  await sessions.run('mutate', f.root, { action: 'remove', packages: ['test-b'] });
  await sessions.run('historyCommit', f.root, { token });
  const manifest = f.read('package.json');
  f.write('package.json', { ...JSON.parse(manifest), dependencies: { 'test-a': 'file:local-libraries/a', 'test-c': 'file:local-libraries/c' } });
  await assert.rejects(sessions.run('historyRestore', f.root, { token, forward: false }), { code: 'LIBRARY_HISTORY_CONFLICT' });
  assert.equal(JSON.parse(f.read('package.json')).dependencies['test-c'], 'file:local-libraries/c');
  f.write('package.json', manifest);
  await sessions.run('historyRestore', f.root, { token, forward: false });
  const localEdit = path.join(f.root, 'local-libraries/b/user-edit.h');
  fs.writeFileSync(localEdit, 'new user source');
  await sessions.run('historyRestore', f.root, { token, forward: true });
  assert.equal(fs.readFileSync(localEdit, 'utf8'), 'new user source');
});


test('local library undo preserves link topology and never deletes preexisting canonical source', async t => {
  const f = await fixture(t), sessions = new LibraryDependencySessions(f.api);
  const logical = path.join(f.root, 'node_modules', 'test-b'), source = path.join(f.root, 'local-libraries', 'b');
  fs.rmSync(logical, { force: true, recursive: true });
  fs.symlinkSync(source, logical, process.platform === 'win32' ? 'junction' : 'dir');
  const { token } = await sessions.run('historyBegin', f.root, { packages: ['test-b'] });
  t.after(() => f.api.history.discard(f.root, token));
  await sessions.run('mutate', f.root, { action: 'remove', packages: ['test-b'] });
  await sessions.run('historyCommit', f.root, { token });
  await sessions.run('historyRestore', f.root, { token, forward: false });
  assert.equal(fs.realpathSync(logical), fs.realpathSync(source));
  assert.ok(fs.lstatSync(logical).isSymbolicLink());
  await sessions.run('historyRestore', f.root, { token, forward: true });
  assert.ok(fs.existsSync(path.join(source, 'package.json')));
  assert.equal(fs.existsSync(logical), false);
});


test('library undo never rolls back over dependency edits made by an external writer during npm', async t => {
  const f = await fixture(t), sessions = new LibraryDependencySessions(f.api);
  const { token } = await sessions.run('historyBegin', f.root, { packages: ['test-b'] });
  t.after(() => f.api.history.discard(f.root, token));
  await sessions.run('mutate', f.root, { action: 'remove', packages: ['test-b'] });
  await sessions.run('historyCommit', f.root, { token });
  const run = f.api.run;
  f.api.run = async (root, request) => {
    const result = await run(root, request);
    f.write('package.json', {...f.api.read(root), dependencies:{...f.api.read(root).dependencies, 'test-c':'file:local-libraries/c'}});
    return result;
  };
  await assert.rejects(sessions.run('historyRestore', f.root, { token, forward: false }), {code:'LIBRARY_DEPENDENCY_INPUT_CHANGED'});
  assert.equal(f.api.read(f.root).dependencies['test-c'], 'file:local-libraries/c');
});
