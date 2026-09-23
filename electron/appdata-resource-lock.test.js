'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function fixture(t, ownerWork = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-appdata-lease-'));
  const handlers = new Map(), localRequire = createRequire(__filename);
  const module = { exports: {} };
  const electron = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { getPath: () => root, getVersion: () => 'test' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'appdata-resource-lock.js'), 'utf8'), {
    require: name => name === 'electron' ? electron
      : name === './npm' ? { waitForOwnerNpmRequests: ownerWork.npm || (() => Promise.resolve()) }
      : name === './cmd' ? { waitForOwnerCmdNpmProcesses: ownerWork.cmd || (() => Promise.resolve()) }
      : localRequire(name), module, exports: module.exports,
    process: { pid: process.pid, execPath: process.execPath, env: { AILY_APPDATA_PATH: root }, kill: process.kill.bind(process) },
    console: { info() {}, warn() {} }, setTimeout,
  }, { filename: 'appdata-resource-lock.js' });
  const api = module.exports; api.registerAppDataResourceLockHandlers();
  const owner = id => Object.assign(new EventEmitter(), { id, destroyed: false,
    isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; this.emit('destroyed'); } });
  const a = owner(1), b = owner(2);
  const call = (sender, action, data) => handlers.get(`appdata-resource-lock-${action}`)({ sender }, data);
  const acquire = (sender, mode, requestId) => call(sender, 'acquire', { mode, requestId, label: requestId, timeoutMs: 3000 });
  t.after(() => {
    api.releaseAllAppDataResourceLocks();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-appdata-lease-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const loadCleanup = (fsApi = fs) => {
    const cleanup = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'appdata-resource-cleanup.js'), 'utf8'), {
      module: cleanup, exports: cleanup.exports,
      require: name => name === 'electron' ? electron : name === './appdata-resource-lock' ? api
        : name === 'node:fs' ? fsApi : localRequire(name),
      process: { env: { AILY_APPDATA_PATH: root } },
    }, { filename: 'appdata-resource-cleanup.js' });
    cleanup.exports.registerAppDataResourceCleanupHandlers();
    cleanup.exports.registerAppDataResourceCleanupHandlers(); // Reopening macOS windows is idempotent.
    return { ...cleanup.exports, remove: (sender, token, target) => handlers.get('appdata-resource-remove')({ sender }, { token, target }) };
  };
  return { root, api, a, b, call, acquire, loadCleanup };
}

test('read wait is independently cancellable; another renderer cannot cancel it', async t => {
  const f = fixture(t), writer = await f.acquire(f.a, 'write', 'install');
  const pending = f.acquire(f.b, 'read', 'compile');
  assert.equal(f.call(f.a, 'cancel', { requestId: 'compile' }).cancelled, false);
  assert.equal(f.call(f.b, 'cancel', { requestId: 'compile' }).cancelled, true);
  assert.equal((await pending).error, 'APPDATA_RESOURCE_LOCK_CANCELLED');
  assert.equal(f.call(f.a, 'release', { token: writer.token }).ok, true);
  assert.equal((await f.acquire(f.b, 'read', 'retry')).ok, true);
});

test('only the reader owner can release or hand off a live lock', async t => {
  const f = fixture(t), reader = await f.acquire(f.a, 'read', 'reader');
  assert.equal(reader.commandHandoff, true);
  assert.equal(f.call(f.b, 'release', { token: reader.token }).ok, false);
  assert.throws(() => f.api.retainAppDataResourceLock(reader.token, f.b.id, 'read'), /NOT_OWNED/);
  f.call(f.a, 'release', { token: reader.token });
  assert.throws(() => f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read'), /NOT_OWNED/);
  const writer = await f.acquire(f.a, 'write', 'writer');
  assert.throws(() => f.api.retainAppDataResourceLock(writer.token, f.a.id, 'read'), /NOT_OWNED/);
});

for (const end of ['release', 'destroy', 'navigate', 'crash']) test(`command borrowers survive renderer ${end}; writer waits for the last borrower`, async t => {
  const f = fixture(t), reader = await f.acquire(f.a, 'read', 'build');
  const first = f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read');
  const second = f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read');
  if (end === 'release') assert.equal(f.call(f.a, 'release', { token: reader.token }).retainedByCommand, true);
  else if (end === 'destroy') f.a.destroy();
  else if (end === 'navigate') f.a.emit('did-start-navigation', {}, 'file:///reloaded', false, true);
  else f.a.emit('render-process-gone', {});
  assert.throws(() => f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read'), /NOT_OWNED/);
  let entered = false;
  const writer = f.acquire(f.b, 'write', 'install').then(r => { entered = true; return r; });
  first.release(); first.release();
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(entered, false); assert.equal(fs.existsSync(reader.lockPath), true);
  second.release();
  assert.equal((await writer).ok, true); assert.equal(fs.existsSync(reader.lockPath), false);
});

test('destroyed queued owner leaves neither pending requests nor listeners', async t => {
  const f = fixture(t); await f.acquire(f.a, 'write', 'install');
  const pending = f.acquire(f.b, 'read', 'queued');
  assert.equal((await f.acquire(f.b, 'read', 'queued')).error, 'APPDATA_RESOURCE_LOCK_INVALID_REQUEST');
  f.b.destroy();
  assert.equal((await pending).ok, false);
  assert.equal(f.call(f.b, 'cancel', { requestId: 'queued' }).cancelled, false);
  assert.equal(f.b.listenerCount('destroyed'), 0);
});

test('reload revokes lending immediately and waits for both legacy npm work and command borrowers', async t => {
  let finishNpm, finishCmd;
  const f = fixture(t, {
    npm: () => new Promise(resolve => { finishNpm = resolve; }),
    cmd: () => new Promise(resolve => { finishCmd = resolve; }),
  });
  const writer = await f.acquire(f.a, 'write', 'install');
  const borrower = f.api.retainAppDataResourceLock(writer.token, f.a.id, 'write');
  f.a.emit('did-start-navigation', {}, 'file:///reload', false, true);
  assert.throws(() => borrower.assertOwnerActive(), /CANCELLED/);
  assert.throws(() => f.api.retainAppDataResourceLock(writer.token, f.a.id, 'write'), /NOT_OWNED/);
  borrower.release();
  assert.equal(f.call(f.a, 'release', { token: writer.token }).retainedByCommand, true);
  finishNpm(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(writer.lockPath), true);
  finishCmd(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(writer.lockPath), false);
  for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
    assert.equal(f.a.listenerCount(event), 0);
  }
  assert.equal((await f.acquire(f.a, 'write', 'reloaded')).ok, true);
});

test('in-page and subframe navigation do not invalidate an active owner', async t => {
  const f = fixture(t), reader = await f.acquire(f.a, 'read', 'reader');
  f.a.emit('did-start-navigation', {}, 'file:///page#hash', true, true);
  f.a.emit('did-start-navigation', {}, 'file:///child', false, false);
  const borrower = f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read');
  borrower.assertOwnerActive(); borrower.release();
  f.call(f.a, 'release', { token: reader.token });
  for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
    assert.equal(f.a.listenerCount(event), 0);
  }
});

test('cancelling a writer waiting for readers removes only its own writer intent', async t => {
  const f = fixture(t), reader = await f.acquire(f.a, 'read', 'reader');
  const pending = f.acquire(f.b, 'write', 'writer');
  f.call(f.b, 'cancel', { requestId: 'writer' });
  assert.equal((await pending).error, 'APPDATA_RESOURCE_LOCK_CANCELLED');
  assert.equal(fs.existsSync(reader.lockPath), true);
  assert.equal((await f.acquire(f.b, 'read', 'another-reader')).ok, true);
});

test('a partially published writer is busy, not a stale lock to delete', async t => {
  const f = fixture(t), lock = path.join(f.root, '.lock/appdata-resource-lock/writer.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, '{');
  const pending = f.acquire(f.a, 'read', 'reader');
  f.call(f.a, 'cancel', { requestId: 'reader' });
  assert.equal((await pending).error, 'APPDATA_RESOURCE_LOCK_CANCELLED');
  assert.equal(fs.readFileSync(lock, 'utf8'), '{');
});

test('a handed-off reader is not reclaimed solely because its main PID died', async t => {
  const f = fixture(t), reader = await f.acquire(f.a, 'read', 'build');
  const borrower = f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read');
  const record = JSON.parse(fs.readFileSync(reader.lockPath, 'utf8'));
  assert.equal(record.commandBorrowed, true);
  fs.writeFileSync(reader.lockPath, JSON.stringify({ ...record, pid: 2147483647 }));
  const writer = f.acquire(f.b, 'write', 'install');
  f.call(f.b, 'cancel', { requestId: 'install' });
  assert.equal((await writer).error, 'APPDATA_RESOURCE_LOCK_CANCELLED');
  assert.equal(fs.existsSync(reader.lockPath), true);
  fs.writeFileSync(reader.lockPath, JSON.stringify(record)); borrower.release();
});

test('writer handoff checks owner and mode and blocks readers after renderer destruction', async t => {
  const f = fixture(t), writer = await f.acquire(f.a, 'write', 'install');
  assert.equal(writer.writerCommandHandoff, true);
  assert.throws(() => f.api.retainAppDataResourceLock(writer.token, f.b.id, 'write'), /NOT_OWNED/);
  assert.throws(() => f.api.retainAppDataResourceLock(writer.token, f.a.id, 'invalid'), /NOT_OWNED/);
  const borrower = f.api.retainAppDataResourceLock(writer.token, f.a.id, 'write');
  f.a.destroy();
  assert.throws(() => f.api.retainAppDataResourceLock(writer.token, f.a.id, 'write'), /NOT_OWNED/);
  let entered = false;
  const reader = f.acquire(f.b, 'read', 'compile').then(r => { entered = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(entered, false); assert.equal(fs.existsSync(writer.lockPath), true);
  borrower.release(); borrower.release();
  assert.equal((await reader).ok, true); assert.equal(fs.existsSync(writer.lockPath), false);
});

test('managed cleanup retains its writer through window destruction until real filesystem completion', async t => {
  const f = fixture(t), writer = await f.acquire(f.a, 'write', 'cleanup');
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const cleanup = f.loadCleanup({ ...fs, promises: { rm: async (...args) => { await gate; return fs.promises.rm(...args); } } });
  const target = path.join(f.root, 'sdk/test'); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'fixture'), 'test');
  await assert.rejects(cleanup.remove(f.b, writer.token, target), /NOT_OWNED/);
  const removing = cleanup.remove(f.a, writer.token, target); f.a.destroy();
  let entered = false;
  const reader = f.acquire(f.b, 'read', 'build').then(r => { entered = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 600)); assert.equal(entered, false);
  assert.equal(fs.existsSync(target), true); assert.equal(fs.existsSync(writer.lockPath), true);
  finish(); assert.equal((await removing).ok, true); assert.equal((await reader).ok, true);
  assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(writer.lockPath), false);
});

test('managed cleanup rejects roots, escapes, nested paths and redirects before deleting anything', async t => {
  const f = fixture(t), cleanup = f.loadCleanup();
  for (const target of [f.root, path.dirname(f.root), path.join(f.root, 'sdk'),
      path.join(f.root, 'node_modules/package'), path.join(f.root, 'sdk/a/b'), 'sdk/relative']) {
    assert.throws(() => cleanup.resolveManagedResource(f.root, target), /PATH_UNSAFE/);
  }
  const outside = path.join(f.root, 'untouched'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.root, 'sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cleanup.resolveManagedResource(f.root, path.join(f.root, 'sdk/resource')), /PATH_UNSAFE/);
  fs.unlinkSync(path.join(f.root, 'sdk')); fs.mkdirSync(path.join(f.root, 'sdk'));
  fs.symlinkSync(outside, path.join(f.root, 'sdk/resource'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cleanup.resolveManagedResource(f.root, path.join(f.root, 'sdk/resource')), /PATH_UNSAFE/);
  assert.equal(fs.existsSync(outside), true);
});

test('failed managed cleanup returns its borrow without bypassing the renderer scope', async t => {
  const f = fixture(t), writer = await f.acquire(f.a, 'write', 'cleanup');
  const cleanup = f.loadCleanup({ ...fs, promises: { rm: async () => { throw new Error('access denied'); } } });
  await assert.rejects(cleanup.remove(f.a, writer.token, path.join(f.root, 'sdk/missing')), /access denied/);
  assert.equal(fs.existsSync(writer.lockPath), true);
  assert.equal(f.call(f.a, 'release', { token: writer.token }).retainedByCommand, undefined);
  assert.equal(fs.existsSync(writer.lockPath), false);
});
