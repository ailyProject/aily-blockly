'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture() {
  const handlers = new Map(), children = [], timers = [], kills = [];
  const owner = Object.assign(new EventEmitter(), { id: 1, destroyed: false,
    isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; this.emit('destroyed'); } });
  const state = { spawnError: undefined, kill: async () => true };
  const dependencies = {
    electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
    child_process: { spawn: () => {
      if (state.spawnError) throw state.spawnError;
      const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, stdout: new EventEmitter(), stderr: new EventEmitter() });
      children.push(child); return child;
    } },
    './process-tree': { killRegisteredProcessTree: async pid => { kills.push(pid); return state.kill(); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'npm.js'), 'utf8'), {
    module, exports: module.exports, require: name => {
      assert.ok(dependencies[name], name); return dependencies[name];
    }, process, AbortController, console: { log() {}, error() {}, warn() {}, info() {} },
    setTimeout: callback => { const timer = { callback }; timers.push(timer); return timer; },
    clearTimeout: timer => { timer.cleared = true; },
  }, { filename: 'npm.js' });
  const api = module.exports; api.registerNpmHandlers();
  const run = (options = {}) => handlers.get('npm-run')({ sender: owner }, {
    cmd: 'npm install fixture', ...options,
  });
  return { api, run, owner, children, timers, kills, state };
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

test('failed termination keeps a live process registered but never retargets its closed PID', async () => {
  const f = fixture(), pending = f.run();
  const rejected = assert.rejects(pending, /CANCELLED/);
  f.state.kill = async () => false;
  assert.equal(await f.api.killAllNpmProcesses(), false);
  assert.equal(f.api.getActiveNpmProcesses().length, 1);
  f.children[0].emit('close', 0, null); await rejected;
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
  assert.equal(await f.api.killAllNpmProcesses(), true); assert.equal(f.kills.length, 1);
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

test('abnormal exit neither retries busy output nor targets a dead PID', async () => {
  const f = fixture(), pending = f.run();
  f.children[0].stderr.emit('data', 'npm error EBUSY rename fixture');
  f.children[0].emit('close', null, 'SIGKILL'); await assert.rejects(pending);
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
  assert.equal(await f.api.killAllNpmProcesses(), true);
  assert.equal(f.timers.length, 0);
  assert.equal(f.kills.length, 0);
});
