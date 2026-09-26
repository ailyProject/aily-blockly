'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const os = require('node:os');

function fixture({ native = false, cwd } = {}) {
  const handlers = new Map(), children = [], timers = [], kills = [];
  const nativeResult = { code: undefined, signal: undefined, stdout: '', stderr: '' };
  const owner = Object.assign(new EventEmitter(), { id: 1, destroyed: false,
    isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; this.emit('destroyed'); } });
  const state = { spawnError: undefined, kill: native
    ? pid => require('./process-tree').killRegisteredProcessTree(pid, 'npm-lifecycle-fixture')
    : async () => true };
  const dependencies = {
    electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
    child_process: { spawn: (...args) => {
      if (state.spawnError) throw state.spawnError;
      const child = native ? require('node:child_process').spawn(args[0], { ...args[1], cwd })
        : Object.assign(new EventEmitter(), { pid: 100 + children.length, stdout: new EventEmitter(), stderr: new EventEmitter() });
      if (native) {
        for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
          nativeResult[stream] = (nativeResult[stream] + String(chunk)).slice(-1000);
        });
        child.on('close', (code, signal) => Object.assign(nativeResult, { code, signal }));
      }
      children.push(child); return child;
    } },
    './process-tree': { killRegisteredProcessTree: async pid => { kills.push(pid); return state.kill(pid); } },
    './project-task-scope': require('./project-task-scope'),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'npm.js'), 'utf8'), {
    module, exports: module.exports, require: name => {
      assert.ok(dependencies[name], name); return dependencies[name];
    }, process, AbortController, console: { log() {}, error() {}, warn() {}, info() {} },
    setTimeout: native ? setTimeout : callback => { const timer = { callback }; timers.push(timer); return timer; },
    clearTimeout: native ? clearTimeout : timer => { timer.cleared = true; },
  }, { filename: 'npm.js' });
  const api = module.exports; api.registerNpmHandlers();
  const run = (options = {}, sender = owner) => handlers.get('npm-run')({ sender }, {
    cmd: 'npm install fixture', ...options,
  });
  return { api, run, owner, children, timers, kills, state, nativeResult };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const busy = child => { child.stderr.emit('data', 'npm error EBUSY rename fixture'); child.emit('close', 1, null); };

test('npm tracks one operation across retries and removes it on completion', async () => {
  const f = fixture(), pending = f.run();
  busy(f.children[0]); await tick();
  assert.equal(f.timers.length, 1); assert.equal(f.api.getActiveNpmProcesses().length, 1);
  f.timers[0].callback(); await tick();
  assert.equal(f.children.length, 2); assert.equal(f.api.getActiveNpmProcesses().length, 1);
  f.children[1].stdout.emit('data', 'done'); f.children[1].emit('close', 0, null);
  assert.equal(await pending, 'done');
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
});

test('owner destruction keeps the active install registered and suppresses retries', async () => {
  const f = fixture(), pending = f.run();
  f.owner.destroy(); assert.equal(f.api.getActiveNpmProcesses().length, 1);
  busy(f.children[0]);
  await assert.rejects(pending, /CANCELLED/);
  assert.equal(f.children.length, 1); assert.equal(f.timers.length, 0);
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
});

for (const end of ['navigate', 'crash']) test(`npm owner ${end} cancels retries but waits for the active installer`, async () => {
  const f = fixture(), pending = f.run();
  const rejected = assert.rejects(pending, /CANCELLED/);
  let completed = false;
  void pending.then(() => { completed = true; }, () => { completed = true; });
  if (end === 'navigate') f.owner.emit('did-start-navigation', {}, 'file:///reload', false, true);
  else f.owner.emit('render-process-gone', {});
  await tick();
  assert.equal(completed, false); assert.equal(f.api.getActiveNpmProcesses().length, 1);
  busy(f.children[0]); await rejected;
  assert.equal(f.children.length, 1); assert.equal(f.timers.length, 0);
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
  for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
    assert.equal(f.owner.listenerCount(event), 0);
  }
});

test('cancelling during a retry wait kills no reused PID and starts no further process', async () => {
  const f = fixture(), pending = f.run();
  const rejected = assert.rejects(pending, /CANCELLED/);
  busy(f.children[0]); await tick();
  assert.equal(await f.api.killAllNpmProcesses(), true);
  await rejected;
  assert.equal(f.timers[0].cleared, true); assert.equal(f.kills.length, 0);
  assert.equal(f.children.length, 1); assert.equal(f.api.getActiveNpmProcesses().length, 0);
});

test('parent close during cancellation keeps the command registered until the tree result', async () => {
  const f = fixture(), pending = f.run();
  const rejected = assert.rejects(pending, /CANCELLED/);
  let finish;
  f.state.kill = () => new Promise(resolve => { finish = resolve; });
  const stopped = f.api.killAllNpmProcesses();
  f.children[0].emit('close', null, 'SIGTERM'); await rejected;
  assert.equal(f.api.getActiveNpmProcesses().length, 1);
  finish(true); assert.equal(await stopped, true);
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
});

test('failed termination stays unresolved after root close and never retargets its closed PID', async () => {
  const f = fixture(), pending = f.run();
  const rejected = assert.rejects(pending, /CANCELLED/);
  f.state.kill = async () => false;
  assert.equal(await f.api.killAllNpmProcesses(), false);
  assert.equal(f.api.getActiveNpmProcesses().length, 1);
  f.children[0].emit('close', 0, null); await rejected;
  assert.equal(f.api.getActiveNpmProcesses().length, 1);
  assert.equal(await f.api.killAllNpmProcesses(), false); assert.equal(f.kills.length, 1);
});

test('failed termination can be retried while its registered root is still alive', async () => {
  const f = fixture(), pending = f.run();
  const rejected = assert.rejects(pending, /CANCELLED/);
  f.state.kill = async () => false;
  assert.equal(await f.api.killAllNpmProcesses(), false);
  f.state.kill = async () => true;
  assert.equal(await f.api.killAllNpmProcesses(), true);
  f.children[0].emit('close', null, 'SIGTERM'); await rejected;
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
  assert.equal(f.kills.length, 2);
});

test('spawn error waits for close; synchronous spawn failure also removes the entry', async () => {
  const f = fixture(), pending = f.run();
  const rejected = assert.rejects(pending, /spawn failed/);
  f.children[0].pid = undefined; f.children[0].emit('error', new Error('spawn failed'));
  await tick(); assert.equal(f.api.getActiveNpmProcesses().length, 1);
  f.children[0].emit('close', -2, null); await rejected;
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
  f.state.spawnError = new Error('invalid options'); await assert.rejects(f.run(), /invalid options/);
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
});

test('shutdown and destroyed owners cannot start npm commands', async () => {
  const f = fixture(); f.owner.destroy();
  await assert.rejects(f.run(), /OWNER_DESTROYED/);
  assert.equal(f.children.length, 0);
  const closing = fixture(); closing.api.beginNpmShutdown();
  await assert.rejects(closing.run(), /SHUTDOWN/);
  assert.equal(closing.children.length, 0);
});

test('abnormal exit stays unresolved without retrying busy output or targeting a dead PID', async () => {
  const f = fixture(), pending = f.run();
  f.children[0].stderr.emit('data', 'npm error EBUSY rename fixture');
  f.children[0].emit('close', null, 'SIGKILL'); await assert.rejects(pending);
  assert.equal(f.api.getActiveNpmProcesses().length, 1);
  assert.equal(await f.api.killAllNpmProcesses(), false);
  assert.equal(f.timers.length, 0);
  assert.equal(f.kills.length, 0);
});

test('project stop isolates npm owners and sessions and rejects late cancelled requests', async () => {
  const { cancelProjectTaskScope } = require('./project-task-scope');
  const f = fixture(), scope = { projectPath: path.resolve('npm-project'), projectSessionId: 'a' };
  const otherOwner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const first = f.run(scope), samePath = f.run({ ...scope, projectSessionId: 'b' }), other = f.run(scope, otherOwner);
  const rejected = assert.rejects(first, /CANCELLED/);
  cancelProjectTaskScope(f.owner, scope);
  assert.equal(await f.api.killOwnerProjectNpmProcesses(f.owner, scope.projectPath, scope.projectSessionId), true);
  assert.deepEqual(f.kills, [100]);
  f.children[0].emit('close', null, 'SIGTERM'); await rejected;
  await assert.rejects(f.run(scope), /PROJECT_TASK_CANCELLED/);
  assert.equal(f.children.length, 3);
  const reopened = f.run({ ...scope, projectSessionId: 'reopened' });
  for (const child of f.children.slice(1)) { child.stdout.emit('data', 'done'); child.emit('close', 0, null); }
  await Promise.all([samePath, other, reopened]);
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
});

test('Windows local npm postinstall cancellation confirms its real descendants exited', { skip: process.platform !== 'win32' }, async t => {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!fs.existsSync(npmCli)) return t.skip('Node installation has no bundled npm CLI.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-npm-cancel-'));
  const receipt = path.join(root, 'fixture-pids.json');
  const f = fixture({ native: true, cwd: root });
  let pids = [];
  t.after(async () => {
    await f.api.killAllNpmProcesses();
    for (const pid of pids) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') continue; throw error; }
      assert.equal(await require('./process-tree').killRegisteredProcessTree(pid, 'npm-fixture-cleanup'), true);
    }
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-npm-cancel-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'aily-local-cancel-fixture', version: '1.0.0',
    scripts: { postinstall: 'node postinstall.js' } }));
  fs.writeFileSync(path.join(root, 'postinstall.js'), `
    const fs = require('node:fs');
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    fs.writeFileSync(require('node:path').join(__dirname, 'fixture-pids.json'), JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
  `);
  const scope = { projectPath: root, projectSessionId: 'native-install' };
  const pending = f.run({ ...scope,
    cmd: `"${process.execPath}" "${npmCli}" install --offline --no-audit --no-fund --ignore-scripts=false --foreground-scripts --prefix "${root}"` });
  const outcome = pending.then(() => null, error => error);
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(receipt) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  t.diagnostic(JSON.stringify({ ...f.nativeResult, reachedPostinstall: fs.existsSync(receipt) }));
  assert.ok(fs.existsSync(receipt), 'Local npm must reach postinstall before cancellation.');
  pids = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(pids.length, 2);
  assert.equal(await f.api.killOwnerProjectNpmProcesses(f.owner, scope.projectPath, scope.projectSessionId), true);
  assert.match((await outcome)?.message || '', /CANCELLED/);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
  t.diagnostic(JSON.stringify({ rootExitCode: f.nativeResult.code, rootSignal: f.nativeResult.signal,
    cancellation: 'confirmed', verifiedExitedDescendants: pids.length }));
});
