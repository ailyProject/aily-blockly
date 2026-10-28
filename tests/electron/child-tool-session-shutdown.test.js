'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const test = require('node:test');
const { createChildToolSessionShutdown } = require('../../electron/child-tool-session-shutdown');
const { stopChildToolSessionProcess } = require('../../electron/child-tool-session-process');
const tick = () => new Promise(resolve => setImmediate(resolve));
const noOwners = { complete: true, errors: [], pending: 0, timedOut: false };

test('global quit closes admission and cancels releases before parallel Runtime shutdown', async () => {
  const calls = [], sessions = [{ id: 'ui-agent' }, { id: 'persistent' }], ends = [];
  let accepting = true;
  const stop = createChildToolSessionShutdown({
    beginShutdown() { accepting = false; calls.push('closed'); }, getSessions: () => sessions,
    cancelRelease: session => calls.push('cancel:' + session.id),
    stopSession(session) { assert.equal(accepting, false); calls.push('stop:' + session.id);
      return new Promise(resolve => ends.push(resolve)); },
  });
  const pending = stop();
  assert.deepEqual(calls, ['closed', 'cancel:ui-agent', 'cancel:persistent']);
  await tick(); assert.equal(ends.length, 2);
  ends[1](true); ends[0](true);
  assert.deepEqual(await pending, { complete: true, timedOut: false, sessions: 2, pending: 0, ownerCleanup: noOwners });
});

test('repeated global quit joins the same work and stops a duplicate session once', async () => {
  const session = {}, calls = []; let finish;
  const stop = createChildToolSessionShutdown({ beginShutdown: () => calls.push('begin'),
    getSessions: () => [session, session], cancelRelease: () => calls.push('cancel'),
    stopSession: () => { calls.push('stop'); return new Promise(resolve => { finish = resolve; }); } });
  const first = stop(); assert.equal(stop(), first); await tick(); finish(true);
  assert.equal((await first).complete, true); assert.equal(stop(), first);
  assert.deepEqual(calls, ['begin', 'cancel', 'stop']);
});

test('a never-settling Runtime yields to the command-tree fallback within the global deadline', async () => {
  let finish;
  const stop = createChildToolSessionShutdown({ beginShutdown() {}, getSessions: () => [{}],
    cancelRelease() {}, stopSession: () => new Promise(resolve => { finish = resolve; }), timeoutMs: 20 });
  const result = await stop();
  assert.deepEqual(result, { complete: false, timedOut: true, sessions: 1, pending: 1, ownerCleanup: noOwners });
  finish(true); await tick();
  assert.equal(await stop(), result, 'late settlement cannot relabel the timed-out global result');
});

test('failed and throwing cleanup both retain an incomplete result while other Runtimes drain', async () => {
  const stop = createChildToolSessionShutdown({ beginShutdown() {}, getSessions: () => [1, 2, 3],
    cancelRelease() {}, stopSession: session => { if (session === 2) throw Error('unconfirmed'); return session === 3; } });
  assert.deepEqual(await stop(), { complete: false, timedOut: false, sessions: 3, pending: 0, ownerCleanup: noOwners });
});

test('empty registry completes without creating Runtime work', async () => {
  const stop = createChildToolSessionShutdown({ beginShutdown() {}, getSessions: () => [],
    cancelRelease() { assert.fail(); }, stopSession() { assert.fail(); } });
  assert.deepEqual(await stop(), { complete: true, timedOut: false, sessions: 0, pending: 0, ownerCleanup: noOwners });
});

test('global quit fences owners before returning and drains them before stopping Runtime', async () => {
  const calls = [], held = Promise.withResolvers(); let fenced = false;
  const stop = createChildToolSessionShutdown({ beginShutdown() {}, getSessions: () => [1], cancelRelease() {},
    drainOwners({ signal }) { assert.equal(signal.aborted, false); fenced = true; calls.push('owners'); return held.promise; },
    stopSession() { calls.push('runtime'); return true; } });
  const pending = stop(); assert.equal(fenced, true); await tick(); assert.deepEqual(calls, ['owners']);
  held.resolve(noOwners); const result = await pending;
  assert.deepEqual(calls, ['owners', 'runtime']); assert.equal(result.complete, true);
  assert.deepEqual(result.ownerCleanup, noOwners);
});

test('owner failure is retained while remaining Runtime shutdown still runs', async () => {
  const failed = { complete: false, errors: ['no ACK'], pending: 0, timedOut: false }; let stops = 0;
  const stop = createChildToolSessionShutdown({ beginShutdown() {}, getSessions: () => [1], cancelRelease() {},
    drainOwners: async () => failed, stopSession() { stops++; return true; } });
  const result = await stop(); assert.equal(stops, 1); assert.equal(result.complete, false);
  assert.deepEqual(result.ownerCleanup, failed); assert.equal(result.timedOut, false);
});

test('owner and Runtime stages share one deadline instead of restarting a timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = Promise.withResolvers(); let stopped = false, result;
  const stop = createChildToolSessionShutdown({ beginShutdown() {}, getSessions: () => [1], cancelRelease() {}, timeoutMs: 20,
    drainOwners: () => new Promise(resolve => setTimeout(() => resolve(noOwners), 15)),
    stopSession() { stopped = true; return runtime.promise; } });
  const pending = stop(); pending.then(value => { result = value; });
  t.mock.timers.tick(15); await tick(); assert.equal(stopped, true); assert.equal(result, undefined);
  t.mock.timers.tick(5); await tick();
  assert.equal(result?.timedOut, true); assert.equal(result.complete, false); assert.equal(result.pending, 1);
  assert.deepEqual(result.ownerCleanup, noOwners);
  runtime.resolve(true); await tick(); assert.equal(await pending, result);
});

test('deadline abort resolving owner drain cannot start a new Runtime stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stopped = 0, result;
  const stop = createChildToolSessionShutdown({ beginShutdown() {}, getSessions: () => [1], cancelRelease() {}, timeoutMs: 20,
    drainOwners: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({
      complete: false, errors: ['deadline'], pending: 1, timedOut: true,
    }), { once: true })), stopSession() { stopped++; return true; } });
  const pending = stop(); pending.then(value => { result = value; });
  t.mock.timers.tick(20); await tick();
  assert.equal(result?.timedOut, true); assert.equal(result.complete, false); assert.equal(stopped, 0);
  assert.equal(result.ownerCleanup.complete, false); assert.equal(await pending, result);
});

test('an opaque owner result cannot be treated as acknowledged cleanup', async () => {
  const stop = createChildToolSessionShutdown({ beginShutdown() {}, getSessions: () => [], cancelRelease() {},
    drainOwners: () => true, stopSession() { assert.fail(); } });
  const result = await stop(); assert.equal(result.complete, false);
  assert.deepEqual(result.ownerCleanup.errors, ['Owner cleanup result unconfirmed']);
});

test('existing process stopper confirms HTTP acceptance and actual process exit before success', async () => {
  let alive = true;
  const session = { streamId: 'owned', hostInfo: { pid: 123, url: 'http://127.0.0.1:10000/',
    shutdownUrl: 'http://127.0.0.1:10000/api/shutdown?token=owned' } };
  const stopped = await stopChildToolSessionProcess(session, {
    fetchImpl: async (url, options) => { assert.equal(url, session.hostInfo.shutdownUrl);
      assert.equal(options.method, 'POST'); alive = false; return { ok: true }; },
    isPidAlive: () => alive, getActiveProcesses: () => alive ? [{ streamId: 'owned' }] : [],
    killStream() { assert.fail('Graceful exit must not enter kill fallback'); },
    killProcessTree() { assert.fail('Graceful exit must not enter kill fallback'); },
  });
  assert.equal(stopped, true);
});

test('existing stopper bounds a never-settling shutdown request before stopping the registered child', async () => {
  let alive = true; const calls = [];
  const stopped = await stopChildToolSessionProcess({ streamId: 'owned', hostInfo: { pid: 123,
    url: 'http://127.0.0.1:10000/', shutdownUrl: 'http://127.0.0.1:10000/api/shutdown' } }, {
    fetchImpl: () => new Promise(() => {}), shutdownRequestTimeoutMs: 5,
    isPidAlive: () => alive, getActiveProcesses: () => [{ streamId: 'owned' }],
    killStream: async id => { calls.push(id); alive = false; },
    killProcessTree() { assert.fail('Already stopped child must not be signalled again'); },
  });
  assert.equal(stopped, true); assert.deepEqual(calls, ['owned']);
});

test('an HTTP success with a surviving process is not mistaken for cleanup completion', async () => {
  let alive = true; const calls = [];
  const stopped = await stopChildToolSessionProcess({ streamId: 'owned', hostInfo: { pid: 123,
    url: 'http://127.0.0.1:10000/', shutdownUrl: 'http://127.0.0.1:10000/api/shutdown' } }, {
    fetchImpl: async () => ({ ok: true }), gracefulShutdownWaitMs: 5, pollIntervalMs: 1,
    isPidAlive: () => alive, getActiveProcesses: () => [{ streamId: 'owned' }],
    killStream: async id => { calls.push(id); },
    killProcessTree: async pid => { calls.push(pid); alive = false; },
  });
  assert.equal(stopped, true); assert.deepEqual(calls, ['owned', 123]);
});

test('window registry stops existing UI/Agent and persistent sessions regardless of lease count', async () => {
  const harness = registryHarness();
  const uiAgent = { streamId: 'shared', hostInfo: { pid: process.pid }, owners: new Map([[1, {}], [2, {}]]) };
  const persistent = { streamId: 'persistent', hostInfo: { pid: process.pid, persistent: true }, owners: new Map() };
  harness.sessions.set('shared', uiAgent); harness.sessions.set('persistent', persistent);
  const result = await harness.exports.stopAllChildToolSessions();
  assert.equal(result.complete, true); assert.deepEqual(harness.stopped, [uiAgent, persistent]);
  assert.equal(harness.sent.filter(channel => channel === 'child-tool-host-shutdown').length, 1);
  assert.throws(() => harness.exports.nativeSubappRegistry.register({}, {}), { code: 'SUBAPP_HOST_SHUTTING_DOWN' });
  assert.equal((await harness.exports.stopAllChildToolSessions()).complete, true);
});

test('global quit rejects renderer acquire and registration before touching sender or payload', async () => {
  const harness = registryHarness(); harness.exports.beginWindowShutdown();
  const forbidden = new Proxy({}, { get() { assert.fail('Closed admission must reject before using input'); } });
  assert.equal(harness.handlers.get('child-tool-session-acquire')(forbidden, forbidden), null);
  const result = await harness.handlers.get('child-tool-session-register')(forbidden, forbidden);
  assert.equal(result.success, false); assert.equal(result.reason, 'application-quitting');
});

function registryHarness() {
  const filename = path.join(__dirname, '../../electron/window.js'), localRequire = createRequire(filename);
  const harness = { stopped: [], sent: [], handlers: new Map() }, module = { exports: {} };
  const source = fs.readFileSync(filename, 'utf8');
  // Evaluate the real production handlers in the same registry context without
  // creating unrelated windows, pools and menu handlers from registerWindowHandlers.
  const start = source.indexOf('    ipcMain.handle("child-tool-session-acquire",');
  const end = source.indexOf('    ipcMain.handle("child-tool-session-message-send",', start);
  assert(start > 0 && end > start);
  vm.runInNewContext(source + '\nmodule.exports.sessionsForTest = childToolSessions;\n' + source.slice(start, end), {
    module, __dirname: path.dirname(filename), process, console, setTimeout, clearTimeout,
    require(id) {
      if (id === 'electron') return { ipcMain: { handle: (name, callback) => harness.handlers.set(name, callback) }, app: { once() {} }, BrowserWindow: { getAllWindows: () => [{
        isDestroyed: () => false, webContents: { isDestroyed: () => false, send: channel => harness.sent.push(channel) },
      }] } };
      if (id === './cmd') return { getActiveCmdProcesses: () => [], onCmdProcessMessage() {}, onCmdProcessExit() {} };
      if (id === './child-tool-session-process') return { stopChildToolSessionProcess: async session => { harness.stopped.push(session); return true; } };
      return localRequire(id);
    },
  }, { filename });
  harness.exports = module.exports; harness.sessions = module.exports.sessionsForTest;
  return harness;
}
