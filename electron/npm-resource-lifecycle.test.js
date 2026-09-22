'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture() {
  const handlers = new Map(), children = [], timers = [], borrows = [], kills = [];
  const owner = Object.assign(new EventEmitter(), { id: 1, destroyed: false,
    isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; this.emit('destroyed'); } });
  const state = { spawnError: undefined, kill: async () => true, releases: 0 };
  const dependencies = {
    electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
    child_process: { spawn: () => {
      if (state.spawnError) throw state.spawnError;
      const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, stdout: new EventEmitter(), stderr: new EventEmitter() });
      children.push(child); return child;
    } },
    './process-tree': { killRegisteredProcessTree: async pid => { kills.push(pid); return state.kill(); } },
    './appdata-resource-lock': { retainAppDataResourceLock: (token, id, mode) => {
      assert.equal(mode, 'write');
      if (token !== 'writer' || id !== 1) throw new Error('APPDATA_RESOURCE_LOCK_NOT_OWNED');
      borrows.push(token); return { release: () => state.releases++ };
    } },
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
    cmd: 'npm install fixture', appDataResourceToken: 'writer', ...options,
  });
  return { api, run, owner, children, timers, borrows, kills, state };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const busy = child => { child.stderr.emit('data', 'npm error EBUSY rename fixture'); child.emit('close', 1, null); };

test('npm holds one writer across retries and releases once on normal completion', async () => {
  const f = fixture(), pending = f.run();
  busy(f.children[0]); await tick();
  assert.equal(f.timers.length, 1); assert.equal(f.state.releases, 0);
  f.timers[0].callback(); await tick();
  assert.equal(f.children.length, 2); assert.equal(f.borrows.length, 1);
  f.children[1].stdout.emit('data', 'done'); f.children[1].emit('close', 0, null);
  assert.equal(await pending, 'done'); assert.equal(f.state.releases, 1);
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
});

test('owner destruction keeps active install protected and suppresses retries', async () => {
  const f = fixture(), pending = f.run();
  f.owner.destroy(); assert.equal(f.state.releases, 0);
  busy(f.children[0]);
  await assert.rejects(pending, /CANCELLED/);
  assert.equal(f.children.length, 1); assert.equal(f.timers.length, 0); assert.equal(f.state.releases, 1);
});

for (const end of ['navigate', 'crash']) test(`npm owner ${end} cancels retries but waits for the active installer`, async () => {
  const f = fixture(), pending = f.run();
  const rejected = assert.rejects(pending, /CANCELLED/);
  let drained = false;
  const waiting = f.api.waitForOwnerNpmRequests(f.owner).then(() => { drained = true; });
  if (end === 'navigate') f.owner.emit('did-start-navigation', {}, 'file:///reload', false, true);
  else f.owner.emit('render-process-gone', {});
  await tick();
  assert.equal(drained, false); assert.equal(f.state.releases, 0);
  busy(f.children[0]); await rejected; await waiting;
  assert.equal(f.children.length, 1); assert.equal(f.timers.length, 0); assert.equal(f.state.releases, 1);
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
  assert.equal(f.children.length, 1); assert.equal(f.state.releases, 1);
});

test('parent close during cancellation cannot release before tree termination confirmation', async () => {
  const f = fixture(), pending = f.run();
  const rejected = assert.rejects(pending, /CANCELLED/);
  let finish;
  f.state.kill = () => new Promise(resolve => { finish = resolve; });
  const stopped = f.api.killAllNpmProcesses();
  f.children[0].emit('close', null, 'SIGTERM'); await rejected;
  assert.equal(f.state.releases, 0); assert.equal(f.api.getActiveNpmProcesses().length, 1);
  finish(true); assert.equal(await stopped, true);
  assert.equal(f.state.releases, 1); assert.equal(f.api.getActiveNpmProcesses().length, 0);
});

test('failed termination retains ownership even if parent later exits with code zero', async () => {
  const f = fixture(), pending = f.run();
  const rejected = assert.rejects(pending, /CANCELLED/);
  f.state.kill = async () => false;
  assert.equal(await f.api.killAllNpmProcesses(), false);
  f.children[0].emit('close', 0, null); await rejected;
  assert.equal(f.state.releases, 0); assert.equal(f.api.getActiveNpmProcesses().length, 1);
  assert.equal(await f.api.killAllNpmProcesses(), false); assert.equal(f.kills.length, 1);
});

test('spawn error waits for close; synchronous spawn failure also returns the borrow', async () => {
  const f = fixture(), pending = f.run();
  const rejected = assert.rejects(pending, /spawn failed/);
  f.children[0].pid = undefined; f.children[0].emit('error', new Error('spawn failed'));
  await tick(); assert.equal(f.state.releases, 0);
  f.children[0].emit('close', -2, null); await rejected; assert.equal(f.state.releases, 1);
  f.state.spawnError = new Error('invalid options'); await assert.rejects(f.run(), /invalid options/);
  assert.equal(f.state.releases, 2); assert.equal(f.api.getActiveNpmProcesses().length, 0);
});

test('invalid writer token refuses spawn; read-only queries keep the existing unlocked path', async () => {
  const f = fixture(); await assert.rejects(f.run({ appDataResourceToken: 'reader' }), /NOT_OWNED/);
  assert.equal(f.children.length, 0);
  const pending = f.run({ cmd: 'npm list --json', appDataResourceToken: undefined });
  f.children[0].stdout.emit('data', '{}'); f.children[0].emit('close', 0, null);
  assert.equal(await pending, '{}'); assert.equal(f.borrows.length, 0);
});

test('abnormal protected exit pins the writer and never retries a dead PID', async () => {
  const f = fixture(), pending = f.run();
  f.children[0].emit('close', null, 'SIGKILL'); await assert.rejects(pending);
  assert.equal(f.state.releases, 0); assert.equal(await f.api.killAllNpmProcesses(), false);
  assert.equal(f.kills.length, 0);
});
