const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LibraryDependencies } = require('../../electron/library-dependencies');
const { LibraryDependencySessions } = require('../../electron/library-dependency-sessions');

function fixture(t, realNpm = false) {
  const parent = path.resolve('tests/test-results/r2-library-status'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'owned-'));
  t.after(() => { assert.ok(root.startsWith(parent + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"status-project","dependencies":{}}\n');
  const run = () => { throw Error('Status cannot run npm'); };
  const manager = new LibraryDependencies(realNpm ? {} : { run }), sessions = new LibraryDependencySessions(manager);
  return { root, manager, sessions };
}

test('a completed read-only settle is not an active library mutation or unsaved library change', async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.root, 'package.json'));
  for (let index = 0; index < 3; index++) {
    const status = await f.sessions.run('status', f.root);
    assert.equal(status.busy, false, 'The status request must not report its own already-settled queue as a writer');
    assert.equal(status.dirty, false);
    assert.equal(f.manager.queues.has(f.root), false); assert.equal(f.sessions.sessions.has(f.root), false);
    assert.equal(f.manager.environment.owned.size, 0);
    assert.ok(fs.readFileSync(path.join(f.root, 'package.json')).equals(before));
    assert.equal(fs.existsSync(path.join(f.root, '.aily/dependency-recovery')), false, 'A clean query cannot invent an environment journal or completed publication');
  }
});

test('a different active queue still blocks library admission', async t => {
  const f = fixture(t); let started, release;
  const entered = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
  const mutation = f.manager.queue(f.root, async () => { started(); await held; });
  await entered;
  try { assert.equal((await f.sessions.run('status', f.root)).busy, true); }
  finally { release(); await mutation; }
  const transaction = await f.sessions.run('begin', f.root, {});
  try { assert.equal((await f.sessions.run('status', f.root)).busy, true, 'An actual edit session remains an owner even between worker jobs'); }
  finally { await f.sessions.run('abort', f.root, undefined, transaction.transaction); }
});

test('an actual uncommitted offline npm library edit remains dirty after the status query settles', async t => {
  const f = fixture(t, true), name = '@aily-project/lib-status-pending', source = path.join(f.root, 'local-libraries', ...name.split('/'));
  fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  const before = fs.readFileSync(path.join(f.root, 'package.json'));
  await f.manager.mutate(f.root, { action: 'install', packages: [`${name}@file:./local-libraries/${name}`], options: { offline: true, installLinks: false } });
  const status = await f.sessions.run('status', f.root);
  assert.equal(status.dirty, true, 'A real pending library entry cannot be admitted as clean');
  assert.equal(status.environment.status, 'running');
  assert.ok(fs.existsSync(path.join(f.root, 'node_modules', ...name.split('/'), 'package.json')));
  assert.ok(fs.readFileSync(path.join(f.root, 'package.json')).equals(before), 'Status must not implicitly save the pending entry');
});
