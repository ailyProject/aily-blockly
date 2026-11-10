'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { npmMutationPrefix, createNpmMutationQueue } = require('../../electron/npm-mutation-queue');
const { npmIpcFixture } = require('./fixtures/npm-ipc-fixture.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily npm queue '));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const install = prefix => ({ command: 'npm', args: ['install', 'board-fixture', '--prefix', prefix] });
const npmOptions = prefix => ({ cmd: `npm install compiler-fixture --prefix "${prefix}"` });
const mockQueue = () => createNpmMutationQueue({ tryAcquire: () => () => {}, pollMs: 5 });

test('both command forms and package postinstall use the actual prefix; read-only queries stay independent', t => {
  const root = temporary(t), canonical = fs.realpathSync(root);
  const expected = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  assert.equal(npmMutationPrefix(install(root)), expected);
  assert.equal(npmMutationPrefix({ commandText: `npm.cmd --prefix="${root}" install fixture` }), expected);
  assert.equal(npmMutationPrefix({ command: 'npm', args: ['run', 'postinstall'],
    cwd: path.join(root, 'node_modules', '@aily-project', 'compiler-esp-x32') }), expected);
  const globalPrefix = path.join(root, 'npm-global');
  assert.equal(npmMutationPrefix({ command: 'npm', args: ['run', 'postinstall'],
    cwd: path.join(root, 'node_modules', '@aily-project', 'compiler-esp-x32'), env: { npm_config_prefix: globalPrefix } }), expected);
  assert.equal(npmMutationPrefix({ command: 'npm', args: ['install', '-g', 'fixture'],
    cwd: root, env: { npm_config_prefix: globalPrefix } }), npmMutationPrefix(install(globalPrefix)));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.equal(npmMutationPrefix({ command: 'npm', args: ['install', 'fixture'], cwd: path.join(root, 'src') }), expected);
  assert.equal(npmMutationPrefix({ commandText: `npm uninstall fixture --prefix '${root}'` }), expected);
  for (const verb of ['view', 'list', 'ls', 'info', 'config', '--version']) {
    assert.equal(npmMutationPrefix({ command: 'npm', args: [verb], cwd: root }), null);
  }
  assert.equal(npmMutationPrefix({ command: process.execPath, args: ['install'], cwd: root }), null);
  const alias = path.join(root, 'alias');
  fs.mkdirSync(path.join(root, 'target'));
  fs.symlinkSync(path.join(root, 'target'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(npmMutationPrefix(install(path.join(alias, 'new'))), npmMutationPrefix(install(path.join(root, 'target', 'new'))));
});

test('FIFO per prefix, cancelled waiter removed, distinct prefix proceeds immediately', async t => {
  const root = temporary(t), acquire = mockQueue(), order = [];
  const first = await acquire(install(root));
  const abort = new AbortController();
  const cancelled = acquire(install(root), { signal: abort.signal });
  const rejected = assert.rejects(cancelled, /CANCELLED/);
  const third = acquire(install(root)).then(release => { order.push('third'); return release; });
  const other = await acquire(install(path.join(root, 'other')));
  abort.abort(); await rejected; await tick(); assert.deepEqual(order, []);
  first(); (await third)(); other(); first();
  assert.deepEqual(order, ['third']);
});

test('external owner waits without blocking the event loop and reports timeout', async t => {
  const root = temporary(t);
  let notifications = 0;
  const acquire = createNpmMutationQueue({ tryAcquire: () => null, pollMs: 5, timeoutMs: 30 });
  await assert.rejects(acquire(install(root), { onWait: () => notifications++ }), /超时/);
  assert.equal(notifications, 1);
});

test('npm-run download finishes before cmd-run starts its board install', async t => {
  const root = temporary(t), f = npmIpcFixture({ acquireNpmMutation: mockQueue() });
  const compiler = f.runNpm(npmOptions(root)); await tick();
  const board = f.runCmd({ ...install(root), streamId: 'board' }); await tick();
  assert.equal(f.children.length, 1);
  assert.ok(f.logs.some(log => log.payload.data?.log?.detail.includes('排队')));
  f.children[0].stdout.emit('data', 'compiler-ready'); f.children[0].emit('close', 0, null);
  assert.equal(await compiler, 'compiler-ready'); assert.equal((await board).success, true);
  assert.equal(f.children.length, 2); f.children[1].emit('close', 0, null);
  assert.equal(f.cmd.getActiveCmdProcesses().length, 0);
});

test('cmd-run failure releases the prefix for npm-run; an error event alone does not', async t => {
  const root = temporary(t), f = npmIpcFixture({ acquireNpmMutation: mockQueue() });
  assert.equal((await f.runCmd({ ...install(root), streamId: 'board' })).success, true);
  const compiler = f.runNpm(npmOptions(root)); await tick();
  f.children[0].emit('error', new Error('temporary process error')); await tick();
  assert.equal(f.children.length, 1);
  f.children[0].emit('close', 1, null); await tick();
  assert.equal(f.children.length, 2); f.children[1].emit('close', 0, null); await compiler;
});

for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
  test(`queued cmd-run is cancelled on owner ${event} and never spawns`, async t => {
    const root = temporary(t), acquire = mockQueue(), release = await acquire(install(root));
    const f = npmIpcFixture({ acquireNpmMutation: acquire });
    const pending = f.runCmd({ ...install(root), streamId: 'cancelled' });
    f.owner.emit(event, {}, 'file:///reload', false, true);
    assert.equal((await pending).success, false);
    release(); await tick(); assert.equal(f.children.length, 0);
    assert.equal(f.owner.listenerCount(event), 0);
  });
}

test('project cancellation removes a queued cmd-run, even before its PID exists', async t => {
  const root = temporary(t), acquire = mockQueue(), release = await acquire(install(root));
  const f = npmIpcFixture({ acquireNpmMutation: acquire });
  const pending = f.runCmd({ ...install(root), streamId: 'project', projectPath: root, projectSessionId: 'one' });
  assert.equal(await f.cmd.killOwnerProjectCmdProcesses(f.owner, root, 'one'), true);
  assert.equal((await pending).success, false);
  release(); await tick(); assert.equal(f.children.length, 0);
});

test('queued npm-run is cancelled on owner navigation without launching later', async t => {
  const root = temporary(t), acquire = mockQueue(), release = await acquire(install(root));
  const f = npmIpcFixture({ acquireNpmMutation: acquire });
  const pending = f.runNpm(npmOptions(root)); const rejected = assert.rejects(pending, /CANCELLED/);
  f.owner.emit('did-start-navigation', {}, 'file:///reload', false, true);
  await rejected; release(); await tick(); assert.equal(f.children.length, 0);
  assert.equal(f.npm.getActiveNpmProcesses().length, 0);
});

test('cmd-run retains its permit until process-tree termination is confirmed', async t => {
  const root = temporary(t), f = npmIpcFixture({ acquireNpmMutation: mockQueue() });
  await f.runCmd({ ...install(root), streamId: 'board' });
  const compiler = f.runNpm(npmOptions(root));
  let finishKill;
  f.state.kill = () => new Promise(resolve => { finishKill = resolve; });
  const stopped = f.cmd.killCmdProcess('board');
  f.children[0].emit('close', null, 'SIGTERM'); await tick();
  assert.equal(f.children.length, 1);
  finishKill(true); assert.equal(await stopped, true); await tick();
  assert.equal(f.children.length, 2); f.children[1].emit('close', 0, null); await compiler;
});

test('failed termination retains the prefix and does not retarget a closed PID', async t => {
  const root = temporary(t), f = npmIpcFixture({ acquireNpmMutation: mockQueue() });
  await f.runCmd({ ...install(root), streamId: 'board' });
  const compiler = f.runNpm(npmOptions(root)); const rejected = assert.rejects(compiler, /CANCELLED/);
  f.state.kill = async () => false;
  assert.equal(await f.cmd.killCmdProcess('board'), false);
  f.children[0].emit('close', 0, null); await tick();
  assert.equal(f.children.length, 1);
  assert.equal(await f.cmd.killCmdProcess('board'), false); assert.equal(f.kills.length, 1);
  await f.npm.killAllNpmProcesses(); await rejected;
});

for (const entryType of ['file', 'directory']) test(`independent hosts share the native prefix lock with .aily as a ${entryType}`, async t => {
  const root = temporary(t), acquire = createNpmMutationQueue({ pollMs: 10 });
  const existing = path.join(root, '.aily');
  const auth = '{"access_token":"isolated-test-token"}\n';
  if (entryType === 'file') fs.writeFileSync(existing, auth, { mode: 0o600 });
  else fs.mkdirSync(existing);
  const release = await acquire(install(root));
  const worker = fork(path.join(__dirname, 'fixtures/npm-prefix-lock-worker.cjs'), [root], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const messages = []; worker.on('message', message => messages.push(message));
  const exited = once(worker, 'exit');
  t.after(async () => { release(); if (worker.exitCode === null) { worker.kill(); await exited; } });
  const waiting = await once(worker, 'message'); assert.equal(waiting[0], 'waiting');
  assert.deepEqual(messages, ['waiting']);
  const acquired = once(worker, 'message'); release(); assert.equal((await acquired)[0], 'acquired');
  assert.equal((await exited)[0], 0);
  assert.ok(fs.statSync(path.join(root, '.aily-npm', 'npm-mutation.lock')).isFile());
  if (entryType === 'file') assert.equal(fs.readFileSync(existing, 'utf8'), auth);
  else assert.deepEqual(fs.readdirSync(existing), []);
});
