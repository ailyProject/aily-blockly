const test = require('node:test');
const assert = require('node:assert/strict');
const resolutionArchives = directory => fs.readdirSync(directory, { withFileTypes: true }).filter(entry => {
  if (!entry.isDirectory()) return true;
  assert.match(entry.name, /^environment-[0-9a-f]{64}$/);
  return false;
}).map(entry => entry.name);
const fs = require('node:fs');
const path = require('node:path');
const { LibraryDependencies, runDependencyWorker } = require('../../electron/library-dependencies');
const { LibraryDependencySessions } = require('../../electron/library-dependency-sessions');
const output = path.resolve(__dirname, '../test-results/library-dependency-recovery');
const name = '@aily-project/lib-demo';
function fixture(t) {
  fs.mkdirSync(output, { recursive: true }); const root = fs.mkdtempSync(path.join(output, 'case-'));
  t.after(() => { assert.equal(path.dirname(root), output); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (file, value) => fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const base = { name: 'fixture', dependencies: { [name]: '1.0.0', independent: '1.0.0' } };
  const staged = { ...base, dependencies: { ...base.dependencies, [name]: '2.0.0', stagedOnly: '4.0.0' } };
  write('package.json', { ...base, dependencies: { ...base.dependencies, [name]: '3.0.0', diskOnly: '5.0.0' } });
  write('package-lock.json', '{"disk":"external lock"}');
  const calls = []; let effect;
  const api = new LibraryDependencies({ run: async (_project, request) => {
    calls.push(request); if (effect) await effect(request);
    const manifest = api.effective(root);
    if (request.save) write('package.json', manifest);
    return { manifest };
  } });
  api.states.set(fs.realpathSync(root), { base, manifest: staged, metadata: {} });
  const offer = () => api.status(root).dependencyConflict;
  const resolve = (choice = 'staged', entry = offer()) => api.recover(root, { version: 1, action: 'resolve',
    token: entry.token, requestId: entry.requestId, choices: entry.entries.map(item => ({ field: item.field, name: item.name, choice })) });
  return { root, api, calls, base, staged, write, read, offer, resolve, setEffect: value => { effect = value; } };
}
test('true conflict is queryable, while effective business manifests/install/save remain rejected', async t => {
  const f = fixture(t), status = f.api.status(f.root), original = f.read('package.json');
  assert.equal(status.manifest, null); assert.equal(status.dirty, true);
  assert.deepEqual(status.dependencyConflict.entries, [{ field: 'dependencies', name, base: '1.0.0', staged: '2.0.0', disk: '3.0.0' }]);
  assert.equal(f.offer().token, status.dependencyConflict.token);
  assert.throws(() => f.api.effective(f.root), { code: 'LIBRARY_DEPENDENCY_CONFLICT' });
  await assert.rejects(f.api.save(f.root), { code: 'LIBRARY_DEPENDENCY_CONFLICT' });
  await assert.rejects(f.api.mutate(f.root, { action: 'install', packages: ['unrelated@1'] }), { code: 'LIBRARY_DEPENDENCY_CONFLICT' });
  assert.equal(f.calls.length, 0); assert.equal(f.read('package.json'), original);
});
test('independent items still merge automatically without issuing a conflict capability', t => {
  const f = fixture(t); f.write('package.json', { ...f.base, dependencies: { ...f.base.dependencies, diskOnly: '5.0.0' } });
  const status = f.api.status(f.root); assert.equal(status.dependencyConflict, undefined);
  assert.equal(status.manifest.dependencies[name], '2.0.0'); assert.equal(status.manifest.dependencies.diskOnly, '5.0.0');
});
for (const choice of ['disk', 'staged']) test(`${choice} chooses only conflict entries, retains both sources and performs no npm or source write`, async t => {
  const f = fixture(t), before = [f.read('package.json'), f.read('package-lock.json')], offered = f.offer();
  const result = await f.resolve(choice, offered);
  assert.equal(result.dependencyRecovery.status, 'completed'); assert.equal(result.treeNeedsReconcile, true);
  assert.equal(result.manifest.dependencies[name], choice === 'staged' ? '2.0.0' : '3.0.0');
  assert.equal(result.manifest.dependencies.stagedOnly, '4.0.0'); assert.equal(result.manifest.dependencies.diskOnly, '5.0.0');
  assert.equal(f.calls.length, 0); assert.deepEqual([f.read('package.json'), f.read('package-lock.json')], before);
  assert.deepEqual((await f.resolve(choice, offered)).dependencyRecovery, result.dependencyRecovery);
  await assert.rejects(f.resolve(choice === 'disk' ? 'staged' : 'disk', offered), { code: 'LIBRARY_DEPENDENCY_RECOVERY_INVALID' });
});
for (const side of ['disk', 'staged']) test(`${side} deletion versus modification is preserved as an explicit per-entry decision`, async t => {
  const f = fixture(t);
  if (side === 'staged') delete f.api.states.get(fs.realpathSync(f.root)).manifest.dependencies[name];
  else { const disk = JSON.parse(f.read('package.json')); delete disk.dependencies[name]; f.write('package.json', disk); }
  const result = await f.resolve(side); assert.equal(result.manifest.dependencies[name], undefined);
  assert.equal(result.manifest.dependencies.independent, '1.0.0');
});
for (const changed of ['package.json', 'package-lock.json', 'state']) test(`old choices cannot acknowledge a new ${changed} input`, async t => {
  const f = fixture(t), offered = f.offer();
  if (changed === 'state') f.api.states.set(fs.realpathSync(f.root), structuredClone(f.api.states.get(fs.realpathSync(f.root))));
  else f.write(changed, f.read(changed) + '\n');
  await assert.rejects(f.resolve('staged', offered), { code: 'LIBRARY_DEPENDENCY_RECOVERY_STALE' });
  assert.notEqual(f.offer().token, offered.token); assert.equal(f.calls.length, 0);
});
test('another dependency queue or private transaction rejects resolve but allows inspection', async t => {
  const f = fixture(t), offered = f.offer(); let release;
  const running = f.api.queue(f.root, () => new Promise(resolve => { release = resolve; })); await Promise.resolve();
  await assert.rejects(f.resolve('staged', offered), { code: 'LIBRARY_DEPENDENCY_RECOVERY_BUSY' });
  assert.equal((await f.api.recover(f.root, { version: 1, action: 'inspect' })).dependencyConflict.token, offered.token);
  release(); await running;
  const sessions = new LibraryDependencySessions(f.api), root = fs.realpathSync(f.root);
  sessions.sessions.set(root, {});
  assert.equal((await sessions.run('recover', root, { version: 1, action: 'resolve', token: offered.token, requestId: offered.requestId, choices: [] })).code,
    'LIBRARY_DEPENDENCY_RECOVERY_BUSY');
});
test('one normal save reconciles once and preserves the exact three-way evidence in a stable archive', async t => {
  const f = fixture(t), offered = f.offer(), before = JSON.parse(f.read('package.json'));
  await f.resolve('staged', offered); assert.equal(f.calls.length, 0);
  await f.api.save(f.root); assert.deepEqual(f.calls.map(request => request.save === true), [false, true]);
  assert.equal(f.api.status(f.root).dirty, false); assert.equal(JSON.parse(f.read('package.json')).dependencies[name], '2.0.0');
  const directory = path.join(f.root, '.aily/dependency-recovery'), files = resolutionArchives(directory);
  assert.deepEqual(files, [offered.requestId + '.json']);
  const archive = JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8'));
  assert.deepEqual(archive.base, f.base); assert.deepEqual(archive.staged, f.staged); assert.deepEqual(archive.disk, before);
  assert.equal(archive.lockText, '{"disk":"external lock"}');
  await f.api.save(f.root); assert.equal(f.calls.length, 2);
  const observed = await f.api.recover(f.root, { version: 1, action: 'observe', token: offered.token, requestId: offered.requestId });
  assert.equal(observed.dependencyRecovery.status, 'completed'); assert.equal(f.calls.length, 2);
});
test('known reconcile failure retains staged state/flag and reuses the same archive after the diagnosed cause changes', async t => {
  const f = fixture(t), offered = f.offer(); await f.resolve('staged', offered);
  f.setEffect(() => { throw new Error('network unavailable'); });
  await assert.rejects(f.api.save(f.root), /network unavailable/);
  let status = f.api.status(f.root); assert.equal(status.treeNeedsReconcile, true); assert.equal(status.reconcileFailure.phase, 'reconcile');
  assert.equal(status.manifest.dependencies[name], '2.0.0'); assert.equal(JSON.parse(f.read('package.json')).dependencies[name], '3.0.0');
  f.setEffect(null); await f.api.save(f.root); status = f.api.status(f.root);
  assert.equal(status.dirty, false); assert.equal(resolutionArchives(path.join(f.root, '.aily/dependency-recovery')).length, 1);
});
test('external writes during reconciliation keep the new disk version and require fresh conflict inspection', async t => {
  const f = fixture(t); await f.resolve();
  f.setEffect(() => { const disk = JSON.parse(f.read('package.json')); disk.dependencies[name] = '4.0.0'; f.write('package.json', disk); f.write('package-lock.json', 'new external lock'); });
  await assert.rejects(f.api.save(f.root));
  const status = f.api.status(f.root); assert.equal(status.treeNeedsReconcile, true); assert.equal(status.manifest, null);
  assert.equal(status.dependencyConflict.entries[0].disk, '4.0.0'); assert.equal(status.dependencyConflict.entries[0].staged, '2.0.0');
  assert.equal(JSON.parse(f.read('package.json')).dependencies[name], '4.0.0'); assert.equal(f.calls.length, 1);
});
test('linked archive directories cannot cause recovery metadata writes outside the project', async t => {
  const f = fixture(t), outside = path.join(output, `outside-${Date.now()}`); fs.mkdirSync(outside);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  await f.resolve(); fs.symlinkSync(outside, path.join(f.root, '.aily/dependency-recovery'), 'junction');
  await assert.rejects(f.api.save(f.root), { code: 'LIBRARY_DEPENDENCY_ARCHIVE_INVALID' });
  assert.deepEqual(fs.readdirSync(outside), []); assert.equal(f.calls.length, 0);
});
test('a lost completed decision remains read-only while a newer draft and owner exist', async t => {
  const f = fixture(t), offered = f.offer(); const first = await f.resolve('staged', offered);
  assert.equal(first.freshCompletion, true);
  f.api.states.get(fs.realpathSync(f.root)).manifest.dependencies[name] = '8.0.0';
  let release; const running = f.api.queue(f.root, () => new Promise(resolve => { release = resolve; })); await Promise.resolve();
  const repeated = await f.resolve('staged', offered);
  assert.equal(repeated.freshCompletion, false); assert.equal(repeated.dependencyRecovery.status, 'completed');
  assert.equal(f.api.states.get(fs.realpathSync(f.root)).manifest.dependencies[name], '8.0.0');
  assert.equal(f.calls.length, 0); release(); await running;
});
test('real npm keeps a same-name local 1/2/3 conflict until explicit resolution, then normal save reconciles the actual link', async t => {
  fs.mkdirSync(output, { recursive: true }); const root = fs.mkdtempSync(path.join(output, 'real-'));
  t.after(() => { assert.equal(path.dirname(root), output); fs.rmSync(root, { recursive: true, force: true }); });
  const packageName = 'test-local-recovery', options = { cache: path.join(root, '.npm-cache'), installLinks: false };
  for (const version of [1, 2, 3]) {
    const directory = path.join(root, 'local-libraries', `version-${version}`); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: packageName, version: `${version}.0.0` }));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0',
    dependencies: { [packageName]: 'file:local-libraries/version-1' } }));
  await runDependencyWorker(root, { options, save: true }); await runDependencyWorker(root, { options });
  let calls = 0;
  const api = new LibraryDependencies({ run: (project, request) => { calls++; return runDependencyWorker(project, request); } });
  await api.mutate(root, { action: 'install', packages: [`${packageName}@file:local-libraries/version-2`], options });
  await runDependencyWorker(root, { add: [`${packageName}@file:local-libraries/version-3`], options, save: true });
  await runDependencyWorker(root, { options });
  const status = api.status(root), originalCalls = calls, before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.equal(status.manifest, null);
  const { token, requestId, entries } = status.dependencyConflict;
  await api.recover(root, { version: 1, action: 'resolve', token, requestId,
    choices: entries.map(entry => ({ field: entry.field, name: entry.name, choice: 'staged' })) });
  assert.equal(calls, originalCalls); assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
  await api.save(root);
  assert.equal(calls, originalCalls + 2); assert.equal(api.status(root).dirty, false);
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', packageName, 'package.json'), 'utf8'));
  assert.equal(installed.version, '2.0.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies[packageName], 'file:local-libraries/version-2');
});
