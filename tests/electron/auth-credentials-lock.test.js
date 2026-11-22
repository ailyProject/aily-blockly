'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

function fixture(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'aily-auth-lock-'));
  const pid = options.pid || 101;
  const state = { now: 2000000000000, boot: 1999999000000, waits: [], cleanup: [] };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../electron/auth-credentials-lock.js'), 'utf8'), {
    module, exports: module.exports,
    require(name) {
      if (name === 'fs') return options.fs || fs;
      if (name === 'os') return { uptime: () => (state.now - state.boot) / 1000 };
      if (name === 'electron') return { app: { getPath: () => root, getVersion: () => 'fixture' } };
      if (name === './child-script-path') return require('../../electron/child-script-path');
      return require(name);
    },
    process: { pid, execPath: process.execPath, env: { AILY_APPDATA_PATH: root },
      kill: options.kill || (owner => {
        if (![101, 202].includes(owner)) throw Object.assign(new Error('exited'), { code: 'ESRCH' });
      }) },
    Date: class extends Date { static now() { return state.now; } },
    console: { warn() {} },
    setTimeout(callback, ms) {
      const timer = { unreferenced: false, unref() { this.unreferenced = true; state.cleanup.push(callback); } };
      queueMicrotask(() => {
        if (!timer.unreferenced) { state.waits.push(ms); state.now += ms; callback(); }
      });
      return timer;
    },
  }, { filename: 'auth-credentials-lock.js' });
  if (!options.root) t.after(() => {
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(actual).startsWith('aily-auth-lock-'));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  const filename = path.join(root, '.lock', 'auth-credentials', 'writer.lock');
  const seed = holder => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, typeof holder === 'string' ? holder : JSON.stringify(holder));
  };
  return { root, filename, seed, state, api: module.exports };
}

test('auth writers preserve the legacy namespace/payload and serialize separate instances', async t => {
  const first = fixture(t), other = fixture(t, { root: first.root, pid: 202 });
  let finish;
  const active = first.api.withAuthCredentialsLock(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  const record = JSON.parse(fs.readFileSync(first.filename));
  assert.equal(record.pid, 101); assert.equal(record.label, 'auth-credentials'); assert.equal(record.mode, 'write');
  assert.equal(record.appVersion, 'fixture'); assert.equal(record.execPath, process.execPath);
  assert.equal(record.startedAt, first.state.now); assert.match(record.token, /^101_\d+_/);
  await assert.rejects(other.api.withAuthCredentialsLock(() => assert.fail('writer overlap')), /AUTH_CREDENTIALS_LOCK_TIMEOUT/);
  assert.deepEqual(other.state.waits, Array(10).fill(500));
  assert.equal(first.api.releaseAllAuthCredentialsLocks().retained, 1);
  finish('done'); assert.equal(await active, 'done');
  assert.equal(await other.api.withAuthCredentialsLock(() => 'next'), 'next');
  assert.equal(fs.existsSync(first.filename), false);
  assert.equal(fs.existsSync(path.join(first.root, '.lock', 'appdata-resource-lock')), false);
});

for (const cause of ['dead-pid', 'earlier-clock', 'permission-denied', 'incomplete', 'missing-owner', 'released-live-owner']) {
  test(`auth writer recovery preserves the existing ${cause} rule`, async t => {
    const f = fixture(t, cause === 'permission-denied' ? {
      kill() { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
    } : {});
    const holder = { pid: cause === 'dead-pid' ? 303 : 202, token: 'legacy-owner', mode: 'write',
      label: 'auth-credentials', startedAt: cause === 'earlier-clock' ? f.state.boot - 6000 : f.state.now };
    if (cause === 'released-live-owner') holder.released = true;
    f.seed(cause === 'incomplete' ? '{' : cause === 'missing-owner' ? {} : holder);
    const acquired = f.api.withAuthCredentialsLock(() => 'acquired');
    if (cause === 'dead-pid') {
      assert.equal(await acquired, 'acquired'); assert.equal(fs.existsSync(f.filename), false);
    } else {
      const code = ['incomplete', 'missing-owner'].includes(cause)
        ? 'AUTH_CREDENTIALS_LOCK_UNVERIFIED' : 'AUTH_CREDENTIALS_LOCK_TIMEOUT';
      await assert.rejects(acquired, { code });
      assert.equal(fs.existsSync(f.filename), true);
    }
  });
}

test('shutdown cancels pending/new acquisitions while retaining active native work', async t => {
  const f = fixture(t);
  let finish;
  const active = f.api.withAuthCredentialsLock(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  const pending = f.api.withAuthCredentialsLock(() => assert.fail('shutdown acquisition'));
  f.api.beginAuthCredentialsShutdown();
  await assert.rejects(pending, /AUTH_CREDENTIALS_LOCK_SHUTDOWN/);
  await assert.rejects(f.api.withAuthCredentialsLock(() => assert.fail('new acquisition')), /AUTH_CREDENTIALS_LOCK_SHUTDOWN/);
  assert.equal(f.api.releaseAllAuthCredentialsLocks().retained, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.filename)).released, undefined);
  finish(); await active;
  assert.equal(f.api.releaseAllAuthCredentialsLocks().ok, true);
  assert.equal(fs.existsSync(f.filename), false);
});

test('completed auth operations publish release before retrying marker deletion', async t => {
  let denied = true;
  const f = fixture(t, { fs: { ...fs, unlinkSync(filename) {
    if (denied && filename.endsWith('writer.lock')) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return fs.unlinkSync(filename);
  } } });
  assert.equal(await f.api.withAuthCredentialsLock(() => 'done'), 'done');
  const holder = JSON.parse(fs.readFileSync(f.filename));
  assert.equal(holder.released, true); assert.equal(holder.commandBorrowed, false);
  assert.equal(f.api.releaseAllAuthCredentialsLocks().ok, true);
  denied = false; f.state.cleanup.shift()();
  assert.equal(fs.existsSync(f.filename), false);
});

test('failed release publication remains retryable and preserves operation errors', async t => {
  let denied = true;
  const f = fixture(t, { fs: { ...fs, renameSync(...args) {
    if (denied) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return fs.renameSync(...args);
  } } });
  await assert.rejects(f.api.withAuthCredentialsLock(() => { throw new Error('operation failed'); }), /operation failed/);
  assert.equal(JSON.parse(fs.readFileSync(f.filename)).released, undefined);
  assert.equal(f.api.releaseAllAuthCredentialsLocks().failed, 1);
  denied = false;
  assert.equal(f.api.releaseAllAuthCredentialsLocks().ok, true);
  assert.equal(fs.existsSync(f.filename), false);
});

test('delayed cleanup cannot unlink a replacement writer', async t => {
  let denied = true;
  const f = fixture(t, { fs: { ...fs, unlinkSync(filename) {
    if (denied && filename.endsWith('writer.lock')) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return fs.unlinkSync(filename);
  } } });
  await f.api.withAuthCredentialsLock(() => undefined);
  const replacement = { pid: 202, token: 'replacement', startedAt: f.state.now, label: 'auth-credentials', mode: 'write' };
  f.seed(replacement); denied = false; f.state.cleanup.shift()();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filename)), replacement);
  assert.equal(f.api.releaseAllAuthCredentialsLocks().ok, true);
});

test('the fixed marker first appears with complete bytes and failed publication cleans only its own intent', async t => {
  const f = fixture(t, { fs: { ...fs, linkSync(staged, filename) {
    assert.equal(fs.existsSync(filename), false);
    assert.equal(JSON.parse(fs.readFileSync(staged)).label, 'auth-credentials');
    fs.linkSync(staged, filename);
    throw new Error('write reported failure');
  } } });
  await assert.rejects(f.api.withAuthCredentialsLock(() => assert.fail('failed acquisition')), /write reported failure/);
  assert.equal(fs.existsSync(f.filename), false);
  assert.equal(f.api.releaseAllAuthCredentialsLocks().ok, true);
});

test('the permanent guard permits resumption after release fails and blocks a competing provisional writer', async t => {
  let denyRelease = true;
  const first = fixture(t, { fs: { ...fs, renameSync(...args) {
    if (denyRelease) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return fs.renameSync(...args);
  } } });
  const second = fixture(t, { root: first.root, pid: 202 });
  let finish;
  const active = first.api.withAuthCredentialsLock(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  const original = JSON.parse(fs.readFileSync(first.filename));
  assert.equal(original.guard.version, 1);
  await assert.rejects(second.api.withAuthCredentialsLock(() => assert.fail('overlap')), { code: 'AUTH_CREDENTIALS_LOCK_TIMEOUT' });
  finish();
  await active;
  assert.equal(JSON.parse(fs.readFileSync(first.filename)).token, original.token);
  const resumed = second.api.withAuthCredentialsLock(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  const replacement = JSON.parse(fs.readFileSync(first.filename));
  assert.notEqual(replacement.token, original.token);
  denyRelease = false;
  first.api.releaseAllAuthCredentialsLocks();
  assert.equal(JSON.parse(fs.readFileSync(first.filename)).token, replacement.token);
  finish();
  await resumed;
  assert.equal(fs.existsSync(first.filename), false);
});

test('an original process exit and two real contenders can only reclaim the old marker once', { timeout: 12000 }, async t => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'aily-auth-lock-process-')));
  const marker = path.join(root, '.lock', 'auth-credentials', 'writer.lock');
  const read = () => JSON.parse(fs.readFileSync(marker));
  const children = [];
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.match(path.basename(root), /^aily-auth-lock-process-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  function forkWriter(mode) {
    const child = fork(path.join(__dirname, 'fixtures/auth-credential-lock-process.cjs'), [root, mode],
      { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit');
    const attempted = new Promise(resolve => {
      child.on('message', message => { if (message === 'attempted') resolve(); });
    });
    const entered = new Promise(resolve => {
      child.on('message', message => { if (message === 'entered') resolve(true); });
    });
    const writer = { child, exited,
      attempted: Promise.race([attempted.then(() => true), exited.then(() => false)]),
      entered: Promise.race([entered, exited.then(() => false)]),
    };
    children.push(writer);
    return writer;
  }
  const first = forkWriter('initial');
  assert.equal(await first.entered, true);
  const original = read();
  first.child.kill();
  await first.exited;
  const observer = forkWriter('observer');
  const limit = Date.now() + 2500;
  while (!fs.existsSync(path.join(root, 'observed'))) {
    assert.ok(Date.now() < limit, 'observer did not reach the stale-marker check');
    await delay(15);
  }
  const contender = forkWriter('contender');
  assert.equal(await contender.attempted, true);
  assert.equal(await Promise.race([contender.entered, delay(600, false)]), false);
  assert.equal(read().token, original.token);
  fs.writeFileSync(path.join(root, 'resume'), '');
  assert.equal(await observer.entered, true);
  const replacement = read();
  assert.equal(replacement.pid, observer.child.pid);
  assert.notEqual(replacement.token, original.token);
  observer.child.send('complete');
  assert.deepEqual(await observer.exited, [0, null]);
  assert.equal(await contender.entered, true);
  assert.equal(read().pid, contender.child.pid);
  assert.notEqual(read().token, replacement.token);
  contender.child.send('complete');
  assert.deepEqual(await contender.exited, [0, null]);
  assert.equal(fs.existsSync(marker), false);
});
