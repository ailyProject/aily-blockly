const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { LibraryDependencies, runDependencyWorker } = require('../../electron/library-dependencies');
const { LibraryDependencySessions } = require('../../electron/library-dependency-sessions');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const parent = path.resolve('tests/test-results/r2-environment-recovery');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'case-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'), external = path.join(directory, 'external');
  fs.mkdirSync(root); fs.mkdirSync(external);
  const write = (name, value) => fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  for (const name of ['r2-parent', 'r2-leaf']) {
    const source = path.join(external, name); fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.mkdirSync(path.join(source, 'bin'));
    fs.writeFileSync(path.join(source, 'bin/probe.js'), '#!/usr/bin/env node\nconsole.log("original-r2-bin");\n');
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0',
      ...(name === 'r2-parent' ? { bin: { 'r2-probe': 'bin/probe.js' } } : {}),
      ...(name === 'r2-parent' ? { dependencies: { 'r2-leaf': `file:${path.join(external, 'r2-leaf-1.0.0.tgz')}` } } : {}) }));
    fs.writeFileSync(path.join(source, 'src/Original.h'), `// retained ${name}\n`);
  }
  execFileSync(path.resolve('child/node', process.platform === 'win32' ? 'node.exe' : 'bin/node'),
    [path.resolve('child/node', process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js'),
      'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', external],
    { cwd: path.join(external, 'r2-leaf'), windowsHide: true, stdio: 'pipe' });
  write('package.json', { name: 'r2-environment-probe', version: '1.0.0', dependencies: { 'r2-parent': 'file:../external/r2-parent' } });
  await runDependencyWorker(root, { save: true, options: { offline: true, ignoreScripts: true, installLinks: true } });
  await runDependencyWorker(root, { options: { offline: true, ignoreScripts: true, installLinks: true } });
  const linked = path.join(root, 'node_modules/r2-parent');
  assert.equal(fs.realpathSync(linked), linked, 'Only the isolated fixture-owned copied package may be replaced during setup');
  fs.rmSync(linked, { recursive: true });
  fs.symlinkSync(path.join(external, 'r2-parent'), linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(fs.lstatSync(path.join(root, 'node_modules/r2-parent')).isSymbolicLink(), 'The fixture must use a real external junction');
  assert.ok(fs.existsSync(path.join(root, 'node_modules/r2-leaf/src/Original.h')), 'Actual npm must install the transitive local dependency');
  for (const name of ['project.abi', 'project.abs', 'project.abs.map.json']) write(name, `original ${name}\n`);
  const before = Object.fromEntries(['package.json', 'package-lock.json', 'project.abi', 'project.abs', 'project.abs.map.json']
    .map(name => [name, fs.readFileSync(path.join(root, name))]));
  const bins = Object.fromEntries(fs.readdirSync(path.join(root, 'node_modules/.bin')).filter(name => name.startsWith('r2-probe'))
    .map(name => [name, { bytes: fs.readFileSync(path.join(root, 'node_modules/.bin', name)),
      link: fs.lstatSync(path.join(root, 'node_modules/.bin', name)).isSymbolicLink() ? fs.readlinkSync(path.join(root, 'node_modules/.bin', name)) : null }]));
  assert.ok(Object.keys(bins).length, 'Actual npm must create executable entrypoints');
  return { root, external, before, bins };
}

for (const mode of ['before-reify', 'after-prune', 'after-lock-write']) test(`whole manager death ${mode} automatically restores retained transitive/junction bytes`, { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const env = { ...process.env, AILY_R2_ENV_PROJECT: f.root, AILY_R2_ENV_BOUNDARY: mode };
  delete env.AILY_LIBRARY_HOST_PID; delete env.ELECTRON_RUN_AS_NODE;
  const child = fork(path.resolve('tests/electron/fixtures/r2-environment-crash.cjs'), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stderr.on('data', value => { output += value; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const paused = await Promise.race([once(child, 'message').then(([value]) => value),
    once(child, 'exit').then(([code]) => { throw Error(`Manager exited before qualification: ${code}: ${output}`); }),
    delay(20000).then(() => { throw Error('The real dependency worker did not reach the requested boundary'); })]);
  assert.equal(paused.paused, mode, JSON.stringify(paused));
  assert.equal(paused.environment.status, 'running');
  const originalRequestId = paused.environment.requestId;
  if (mode !== 'before-reify') assert.equal(fs.existsSync(path.join(f.root, 'node_modules/r2-parent')), false, 'Actual npm must have pruned the linked package');
  else assert.ok(paused.locations.some(name => name.includes('r2-leaf')), 'The real Arborist diff must retain transitive prune scope');
  if (mode === 'after-lock-write') assert.equal(fs.readFileSync(path.join(f.root, 'package-lock.json')).equals(f.before['package-lock.json']), false,
    'This boundary must exercise an actual changed lockfile, not only a planned write');
  child.kill('SIGKILL'); await once(child, 'close');
  // A newer external source remains user-owned. Recovery must use the archived
  // exact old bytes inside this project instead of writing through its junction.
  if (mode === 'after-prune') fs.writeFileSync(path.join(f.external, 'r2-parent/src/Original.h'), '// newer external source\n');
  const api = new LibraryDependencies(), sessions = new LibraryDependencySessions(api);
  let status, lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { status = await sessions.run('status', f.root); break; }
    catch (error) { lastError = error; if (error.code !== 'LIBRARY_ENVIRONMENT_UNCERTAIN') throw error; await delay(100); }
  }
  assert.ok(status, lastError?.stack);
  assert.equal(status.environment.status, 'restored'); assert.equal(status.environment.requestId, originalRequestId);
  assert.equal(fs.readFileSync(path.join(f.root, 'node_modules/r2-parent/src/Original.h'), 'utf8'), '// retained r2-parent\n');
  assert.equal(fs.readFileSync(path.join(f.root, 'node_modules/r2-leaf/src/Original.h'), 'utf8'), '// retained r2-leaf\n');
  if (mode === 'after-prune') assert.equal(fs.readFileSync(path.join(f.external, 'r2-parent/src/Original.h'), 'utf8'), '// newer external source\n');
  for (const [name, bytes] of Object.entries(f.before)) assert.ok(fs.readFileSync(path.join(f.root, name)).equals(bytes), `${name} must retain its exact original bytes`);
  for (const [name, value] of Object.entries(f.bins)) {
    const file = path.join(f.root, 'node_modules/.bin', name);
    assert.ok(fs.readFileSync(file).equals(value.bytes), `${name} retains its original executable bytes`);
    assert.equal(fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : null, value.link, `${name} retains original link topology`);
  }
  const observed = await api.observeEnvironment(f.root, { requestId: originalRequestId });
  assert.equal(observed.environment.status, 'restored'); assert.equal(observed.environment.current, true);
});

test('explicit dependency-session abort restores the exact old bytes and releases ownership for a fresh manager', { timeout: 60000 }, async t => {
  const f = await fixture(t), api = new LibraryDependencies(), sessions = new LibraryDependencySessions(api);
  const { transaction } = await sessions.run('begin', f.root);
  const original = api.environment.describe(f.root).requestId;
  await sessions.run('mutate', f.root, { action: 'remove', packages: ['r2-parent'], options: { offline: true } }, transaction);
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules/r2-parent')), false);
  await sessions.run('abort', f.root, undefined, transaction);
  for (const [name, bytes] of Object.entries(f.before)) assert.ok(fs.readFileSync(path.join(f.root, name)).equals(bytes), name);
  assert.equal(fs.readFileSync(path.join(f.root, 'node_modules/r2-parent/src/Original.h'), 'utf8'), '// retained r2-parent\n');
  const fresh = new LibraryDependencies(), observed = await fresh.observeEnvironment(f.root, { requestId: original });
  assert.equal(observed.environment.status, 'restored'); assert.equal(observed.environment.current, true);
  assert.equal((await new LibraryDependencySessions(fresh).run('status', f.root)).dirty, false);
});
