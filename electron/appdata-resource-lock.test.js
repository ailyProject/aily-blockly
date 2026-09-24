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
  const root = ownerWork.root || fs.mkdtempSync(path.join(os.tmpdir(), 'aily-appdata-lease-'));
  const handlers = new Map(), localRequire = createRequire(__filename);
  const module = { exports: {} };
  const electron = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { getPath: () => root, getVersion: () => 'test' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'appdata-resource-lock.js'), 'utf8'), {
    require: name => name === 'electron' ? electron
      : name === './npm' ? { waitForOwnerNpmRequests: ownerWork.npm || (() => Promise.resolve()) }
      : name === './cmd' ? { waitForOwnerCmdNpmProcesses: ownerWork.cmd || (() => Promise.resolve()) }
      : name === 'fs' && ownerWork.fs ? ownerWork.fs : localRequire(name), module, exports: module.exports,
    process: { pid: process.pid, execPath: process.execPath, env: { AILY_APPDATA_PATH: root }, kill: ownerWork.kill || process.kill.bind(process) },
    console: { info() {}, warn() {} }, setTimeout: ownerWork.setTimeout || setTimeout, Date: ownerWork.Date || Date,
  }, { filename: 'appdata-resource-lock.js' });
  const api = module.exports; api.registerAppDataResourceLockHandlers();
  const owner = id => Object.assign(new EventEmitter(), { id, destroyed: false,
    isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; this.emit('destroyed'); } });
  const a = owner(1), b = owner(2);
  const call = (sender, action, data) => handlers.get(`appdata-resource-lock-${action}`)({ sender }, data);
  const acquire = (sender, mode, requestId) => call(sender, 'acquire', { mode, requestId, label: requestId, timeoutMs: 3000 });
  t.after(() => {
    api.releaseAllAppDataResourceLocks();
    if (ownerWork.root) return;
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

test('writer timeout removes its intent and listeners without releasing existing readers', { timeout: 3000 }, async t => {
  const f = fixture(t), reader = await f.acquire(f.a, 'read', 'active-reader');
  const result = await f.call(f.b, 'acquire', { mode: 'write', requestId: 'short-writer', timeoutMs: 20 });
  assert.equal(result.error, 'APPDATA_RESOURCE_LOCK_TIMEOUT');
  assert.equal(fs.existsSync(path.join(f.root, '.lock/appdata-resource-lock/writer.lock')), false);
  assert.equal(fs.existsSync(reader.lockPath), true);
  assert.equal(f.call(f.b, 'cancel', { requestId: 'short-writer' }).cancelled, false);
  for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
    assert.equal(f.b.listenerCount(event), 0);
  }
  assert.equal((await f.acquire(f.b, 'read', 'unblocked-reader')).ok, true);
});

for (const mode of ['read', 'write']) test(`zero timeout ${mode} request settles without polling behind a holder`, { timeout: 3000 }, async t => {
  const f = fixture(t), holder = await f.acquire(f.a, mode === 'read' ? 'write' : 'read', 'holder');
  const pending = f.call(f.b, 'acquire', { mode, requestId: 'immediate', timeoutMs: 0 });
  const immediate = await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve(undefined)))]);
  // Drain a broken zero-timeout request so the regression cannot run for 30 minutes.
  if (!immediate) {
    f.call(f.b, 'cancel', { requestId: 'immediate' });
    await pending;
  }
  assert.equal(fs.existsSync(holder.lockPath), true);
  assert.ok(immediate, 'A zero acquisition budget must not enter the polling wait.');
  assert.equal(immediate.error, 'APPDATA_RESOURCE_LOCK_TIMEOUT');
});

for (const timeoutMs of [undefined, 30 * 60 * 1000]) test(`IPC acquisition budget ${timeoutMs} stops after five seconds`, { timeout: 3000 }, async t => {
  const startedAt = Date.now();
  let now = startedAt;
  const f = fixture(t, { Date: class extends Date { static now() { return now; } },
    setTimeout(callback, ms) {
      now += ms;
      assert.ok(now - startedAt <= 5000, 'The default acquisition budget must not continue beyond five seconds.');
      queueMicrotask(callback);
    } });
  const holder = await f.acquire(f.a, 'write', 'holder');
  const result = await f.call(f.b, 'acquire', { mode: 'read', requestId: 'legacy-default', timeoutMs });
  assert.equal(result.error, 'APPDATA_RESOURCE_LOCK_TIMEOUT');
  assert.equal(now - startedAt, 5000);
  assert.equal(fs.existsSync(holder.lockPath), true);
});

test('the last returned borrower clears the crash pin while its renderer scope remains live', { timeout: 3000 }, async t => {
  let denied = false;
  const f = fixture(t, { fs: { ...fs, renameSync(...args) {
    if (denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.renameSync(...args);
  } } });
  const reader = await f.acquire(f.a, 'read', 'reader');
  const first = f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read');
  const last = f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read');
  first.release();
  assert.equal(JSON.parse(fs.readFileSync(reader.lockPath)).commandBorrowed, true);
  denied = true;
  assert.equal(last.release().ok, false);
  assert.equal(JSON.parse(fs.readFileSync(reader.lockPath)).commandBorrowed, true);
  denied = false;
  assert.equal(last.release().ok, true);
  assert.equal(fs.existsSync(reader.lockPath), true);
  assert.notEqual(JSON.parse(fs.readFileSync(reader.lockPath)).commandBorrowed, true,
    'No command remains to justify pinning this lock after a later host crash.');
  assert.notEqual(JSON.parse(fs.readFileSync(reader.lockPath)).released, true,
    'The renderer scope still owns the lock after the command returns.');
  const next = f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read');
  assert.equal(JSON.parse(fs.readFileSync(reader.lockPath)).commandBorrowed, true);
  next.release();
});

test('reader enumeration failure returns only the requesting writers reserved intent', { timeout: 3000 }, async t => {
  const failure = Object.assign(new Error('reader directory denied'), { code: 'EACCES' });
  const f = fixture(t, { fs: { ...fs, readdirSync() { throw failure; } } });
  await assert.rejects(f.call(f.a, 'acquire', { mode: 'write', requestId: 'failed-writer', timeoutMs: 20 }),
    /reader directory denied/);
  assert.equal(f.call(f.a, 'cancel', { requestId: 'failed-writer' }).cancelled, false);
  assert.equal(f.a.listenerCount('destroyed'), 0);
  assert.equal(fs.existsSync(path.join(f.root, '.lock/appdata-resource-lock/writer.lock')), false,
    'A failed acquisition must not leave a writer intent owned by a live main process.');
});

test('failed intent removal is ended before deletion retries and does not block shutdown', { timeout: 3000 }, async t => {
  let denied = true;
  const f = fixture(t, { fs: { ...fs, unlinkSync(filename) {
    if (denied && filename.endsWith('writer.lock')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.unlinkSync(filename);
  } } });
  const reader = await f.acquire(f.a, 'read', 'reader');
  const result = await f.call(f.b, 'acquire', { mode: 'write', requestId: 'writer', timeoutMs: 0 });
  assert.equal(result.error, 'APPDATA_RESOURCE_LOCK_TIMEOUT');
  f.call(f.a, 'release', { token: reader.token });
  const cleanup = f.api.releaseAllAppDataResourceLocks();
  assert.equal(cleanup.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, '.lock/appdata-resource-lock/writer.lock'))).released, true);
  denied = false;
  assert.equal(f.api.releaseAllAppDataResourceLocks().ok, true);
});

test('cancelled reader rollback remains tracked when unlink fails and can be retried', async t => {
  let denied = true, readerPath;
  const f = fixture(t, { fs: { ...fs,
    writeFileSync(filename, ...args) {
      fs.writeFileSync(filename, ...args);
      if (typeof filename === 'string' && filename.endsWith('.lock')) {
        readerPath = filename;
        f.call(f.a, 'cancel', { requestId: 'cancel-reader' });
      }
    },
    unlinkSync(filename) {
      if (denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.unlinkSync(filename);
    }
  } });
  const result = await f.acquire(f.a, 'read', 'cancel-reader');
  assert.equal(result.error, 'APPDATA_RESOURCE_LOCK_CANCELLED');
  assert.equal(fs.existsSync(readerPath), true);
  assert.equal(f.api.releaseAllAppDataResourceLocks().ok, true);
  assert.equal(JSON.parse(fs.readFileSync(readerPath)).released, true);
  denied = false;
  assert.equal(f.api.releaseAllAppDataResourceLocks().ok, true);
  assert.equal(fs.existsSync(readerPath), false);
});

test('PID permission denial does not authorize reclaiming a holder', { timeout: 3000 }, async t => {
  const f = fixture(t, { kill() { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } });
  const writer = await f.acquire(f.a, 'write', 'protected-writer');
  const result = await f.call(f.b, 'acquire', { mode: 'read', requestId: 'reader', timeoutMs: 0 });
  assert.equal(result.error, 'APPDATA_RESOURCE_LOCK_TIMEOUT');
  assert.equal(fs.existsSync(writer.lockPath), true);
});

test('failed stale removal cannot make a present writer appear unlocked', { timeout: 3000 }, async t => {
  const f = fixture(t, { fs: { ...fs, unlinkSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } });
  const writerPath = path.join(f.root, '.lock/appdata-resource-lock/writer.lock');
  fs.mkdirSync(path.dirname(writerPath), { recursive: true });
  const bytes = JSON.stringify({ pid: 2147483647, token: 'dead-writer', startedAt: Date.now() });
  fs.writeFileSync(writerPath, bytes);
  const result = await f.call(f.a, 'acquire', { mode: 'read', requestId: 'reader', timeoutMs: 0 });
  assert.equal(result.error, 'APPDATA_RESOURCE_LOCK_TIMEOUT');
  assert.equal(fs.readFileSync(writerPath, 'utf8'), bytes);
});

test('release-all distinguishes active borrowers, pending marker cleanup and completed cleanup', { timeout: 3000 }, async t => {
  let denied = true;
  const f = fixture(t, { fs: { ...fs, unlinkSync(filename) {
    if (denied && filename.endsWith('.lock')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.unlinkSync(filename);
  } } });
  const reader = await f.acquire(f.a, 'read', 'reader');
  const borrower = f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read');
  f.call(f.a, 'release', { token: reader.token });
  let result = f.api.releaseAllAppDataResourceLocks();
  assert.equal(result.ok, false); assert.equal(result.retained, 1); assert.equal(result.failed, 0);
  assert.equal(borrower.release().ok, true);
  result = f.api.releaseAllAppDataResourceLocks();
  assert.equal(result.ok, true); assert.equal(result.failed, 0);
  assert.equal(fs.existsSync(reader.lockPath), true);
  const marker = JSON.parse(fs.readFileSync(reader.lockPath));
  assert.equal(marker.released, true); assert.equal(marker.commandBorrowed, false);
  denied = false;
  assert.equal(borrower.release().ok, true);
  assert.equal(f.api.releaseAllAppDataResourceLocks().ok, true);
  assert.equal(fs.existsSync(reader.lockPath), false);
});

for (const mode of ['read', 'write']) test(`release-all preserves an unreturned renderer ${mode} scope`, { timeout: 3000 }, async t => {
  const f = fixture(t), lock = await f.acquire(f.b, mode, 'other-window');
  const result = f.api.releaseAllAppDataResourceLocks();
  assert.equal(result.ok, false);
  assert.equal(result.retained, 1);
  assert.equal(fs.existsSync(lock.lockPath), true);
  // A failed quit must not revoke a scope that can continue after admission resumes.
  const borrower = f.api.retainAppDataResourceLock(lock.token, f.b.id, mode);
  borrower.release();
  f.call(f.b, 'release', { token: lock.token });
  assert.equal(f.api.releaseAllAppDataResourceLocks().ok, true);
});

test('shutdown cancels pending requests, refuses new borrowing and retains active native scopes', { timeout: 3000 }, async t => {
  const f = fixture(t), reader = await f.acquire(f.a, 'read', 'reader');
  const waiting = f.acquire(f.b, 'write', 'pending');
  let finish;
  const native = f.api.withAppDataResourceLock('auth-test', () => new Promise(resolve => { finish = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  f.api.beginAppDataResourceShutdown();
  assert.throws(() => f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read'), /SHUTDOWN/);
  assert.equal((await f.acquire(f.a, 'read', 'new')).error, 'APPDATA_RESOURCE_LOCK_SHUTDOWN');
  await assert.rejects(f.api.withAppDataResourceLock('new-native', () => assert.fail('must not enter')), /SHUTDOWN/);
  assert.equal((await waiting).error, 'APPDATA_RESOURCE_LOCK_CANCELLED');
  f.call(f.a, 'release', { token: reader.token });
  assert.equal(f.api.releaseAllAppDataResourceLocks().ok, false);
  finish(); await native;
  assert.equal(f.api.releaseAllAppDataResourceLocks().ok, true);
});

test('shutdown waits for a pending native acquisition to remove its reserved intent', async t => {
  const f = fixture(t);
  let finish;
  const native = f.api.withAppDataResourceLock('native-test', () => new Promise(resolve => { finish = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const waiting = assert.rejects(f.api.withAppDataResourceLock('native-test', () => assert.fail('must not enter')), /OWNER_DESTROYED/);
  f.api.beginAppDataResourceShutdown();
  finish(); await native;
  assert.equal(f.api.releaseAllAppDataResourceLocks().retained, 1);
  await waiting;
  assert.equal(f.api.releaseAllAppDataResourceLocks().ok, true);
});

test('project cleanup retries its ended renderer leases without touching another renderer', async t => {
  let failUnlink = true;
  const f = fixture(t, { fs: { ...fs, unlinkSync(filename) {
    if (failUnlink && filename.endsWith('.lock')) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return fs.unlinkSync(filename);
  } } });
  const own = await f.acquire(f.a, 'read', 'closing-project');
  const other = await f.acquire(f.b, 'read', 'other-project');
  assert.equal(f.call(f.a, 'release', { token: own.token }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(own.lockPath)).released, true);
  assert.equal(f.api.releaseAllAppDataResourceLocks(f.a.id).ok, true);
  failUnlink = false;
  assert.equal(f.api.releaseAllAppDataResourceLocks(f.a.id).ok, true);
  assert.equal(fs.existsSync(own.lockPath), false);
  assert.equal(fs.existsSync(other.lockPath), true);
  assert.equal(f.call(f.b, 'release', { token: other.token }).ok, true);
});

test('released readers do not block another instance when their live owner cannot unlink them', async t => {
  const deniedReaderUnlink = { ...fs, unlinkSync(filename) {
    if (path.basename(path.dirname(filename)) === 'readers' && filename.endsWith('.lock')) {
      throw Object.assign(new Error('busy reader marker'), { code: 'EPERM' });
    }
    return fs.unlinkSync(filename);
  } };
  const f = fixture(t, { fs: deniedReaderUnlink });
  const reader = await f.acquire(f.a, 'read', 'ended-reader');
  const borrower = f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read');
  f.call(f.a, 'release', { token: reader.token });
  const other = fixture(t, { root: f.root, fs: deniedReaderUnlink });
  assert.equal((await other.call(other.a, 'acquire', { mode: 'write', requestId: 'still-running', timeoutMs: 0 })).ok, false);
  assert.notEqual(JSON.parse(fs.readFileSync(reader.lockPath)).released, true);
  assert.equal(borrower.release().ok, true);
  assert.equal(JSON.parse(fs.readFileSync(reader.lockPath)).released, true);
  assert.equal(JSON.parse(fs.readFileSync(reader.lockPath)).pid, process.pid);
  const writer = await other.call(other.a, 'acquire', { mode: 'write', requestId: 'after-end', timeoutMs: 0 });
  assert.equal(writer.ok, true);
  assert.equal(fs.existsSync(reader.lockPath), true, 'The released marker may remain without holding a reader slot.');
  other.call(other.a, 'release', { token: writer.token });
});

test('a live released writer is removed only by its owner and retried without keeping the app alive', async t => {
  let retry, unref = false, denied = true;
  const f = fixture(t, { fs: { ...fs, unlinkSync(filename) {
    if (denied && filename.endsWith('writer.lock')) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return fs.unlinkSync(filename);
  } }, setTimeout(callback, ms) { assert.equal(ms, 500); retry = callback; return { unref() { unref = true; } }; } });
  const writer = await f.acquire(f.a, 'write', 'ending-writer');
  assert.equal(f.call(f.a, 'release', { token: writer.token }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(writer.lockPath)).released, true);
  assert.equal(unref, true);
  const other = fixture(t, { root: f.root });
  assert.equal((await other.call(other.a, 'acquire', { mode: 'read', requestId: 'wait-for-cleanup', timeoutMs: 0 })).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(writer.lockPath)).token, writer.token);
  denied = false; retry();
  assert.equal(fs.existsSync(writer.lockPath), false);
  const reader = await other.call(other.a, 'acquire', { mode: 'read', requestId: 'after-cleanup', timeoutMs: 0 });
  assert.equal(reader.ok, true);
  other.call(other.a, 'release', { token: reader.token });
});

test('a released writer from an exited instance is recoverable and delayed cleanup never removes its replacement', async t => {
  let retry, denied = true;
  const f = fixture(t, { fs: { ...fs, unlinkSync(filename) {
    if (denied && filename.endsWith('writer.lock')) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return fs.unlinkSync(filename);
  } }, setTimeout(callback) { retry = callback; return { unref() {} }; } });
  const old = await f.acquire(f.a, 'write', 'ended');
  assert.equal(f.call(f.a, 'release', { token: old.token }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(old.lockPath)).released, true);
  const other = fixture(t, { root: f.root,
    kill() { throw Object.assign(new Error('owner exited'), { code: 'ESRCH' }); } });
  const reader = await other.call(other.a, 'acquire', { mode: 'read', requestId: 'recovery', timeoutMs: 0 });
  assert.equal(reader.ok, true);
  other.call(other.a, 'release', { token: reader.token });
  const replacement = await other.call(other.a, 'acquire', { mode: 'write', requestId: 'replacement', timeoutMs: 0 });
  assert.equal(replacement.ok, true);
  denied = false; retry();
  assert.equal(JSON.parse(fs.readFileSync(replacement.lockPath)).token, replacement.token);
  assert.equal(f.api.releaseAllAppDataResourceLocks().ok, true);
  other.call(other.a, 'release', { token: replacement.token });
});

test('failed release publication preserves the borrowed pin and remains an explicit cleanup failure', async t => {
  let failRename = false;
  const f = fixture(t, { fs: { ...fs, renameSync(...args) {
    if (failRename) throw Object.assign(new Error('marker denied'), { code: 'EACCES' });
    return fs.renameSync(...args);
  } } });
  const reader = await f.acquire(f.a, 'read', 'reader');
  const borrower = f.api.retainAppDataResourceLock(reader.token, f.a.id, 'read');
  f.call(f.a, 'release', { token: reader.token });
  failRename = true;
  assert.equal(borrower.release().ok, false);
  const marker = JSON.parse(fs.readFileSync(reader.lockPath));
  assert.equal(marker.commandBorrowed, true); assert.notEqual(marker.released, true);
  const result = f.api.releaseAllAppDataResourceLocks();
  assert.equal(result.ok, false); assert.equal(result.failed, 1);
  failRename = false;
  assert.equal(f.api.releaseAllAppDataResourceLocks().ok, true);
  assert.equal(fs.existsSync(reader.lockPath), false);
});

test('owner work and native work must finish before their locks are marked released', async t => {
  let finishOwner, finishNative;
  const f = fixture(t, { npm: () => new Promise(resolve => { finishOwner = resolve; }),
    fs: { ...fs, unlinkSync(filename) {
      if (filename.endsWith('.lock')) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return fs.unlinkSync(filename);
    } } });
  const reader = await f.acquire(f.a, 'read', 'owner-work');
  f.a.destroy();
  assert.equal(f.api.releaseAllAppDataResourceLocks().retained, 1);
  assert.notEqual(JSON.parse(fs.readFileSync(reader.lockPath)).released, true);
  finishOwner(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(fs.readFileSync(reader.lockPath)).released, true);
  const native = f.api.withAppDataResourceLock('native-test', () => new Promise(resolve => { finishNative = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const nativePath = path.join(f.root, '.lock/native-test/writer.lock');
  assert.equal(f.api.releaseAllAppDataResourceLocks().retained, 1);
  assert.notEqual(JSON.parse(fs.readFileSync(nativePath)).released, true);
  finishNative(); await native;
  assert.equal(JSON.parse(fs.readFileSync(nativePath)).released, true);
  assert.equal(f.api.releaseAllAppDataResourceLocks().ok, true);
});
