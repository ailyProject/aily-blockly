'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

test('main broadcasts an exact-stream exit to every window even after its spawning renderer has gone', () => {
  const harness = createHarness();
  const session = harness.register('stream-1');
  harness.exit({ streamId: 'other-stream', code: 1, signal: null, expected: false });
  assert.equal(harness.messages.length, 0);
  harness.exit({ streamId: 'stream-1', code: 1, signal: null, expected: false });
  assert.equal(harness.messages.length, 2);
  for (const message of harness.messages) {
    assert.equal(message.channel, 'child-tool-session-state-changed');
    assert.equal(message.payload[0].running, false);
    assert.equal(message.payload[0].exit.expected, false);
  }
  assert.equal(harness.api.isChildToolSessionAlive(session), false);
  harness.register('stream-2');
  harness.exit({ streamId: 'stream-1', code: 1, signal: null, expected: false });
  assert.equal(harness.messages.length, 2);
  assert.equal(harness.api.listChildToolSessions()[0].running, true);
});

test('graceful shutdown is marked expected before the process exits', async () => {
  const harness = createHarness();
  const session = harness.register('stream-1');
  harness.stop = async current => {
    assert.equal(current.stopping, true);
    harness.exit({ streamId: 'stream-1', code: 0, signal: null, expected: false });
    return true;
  };
  assert.equal(await harness.api.stopChildToolSessionProcess(session), true);
  assert.equal(session.stopping, false);
  assert.equal(harness.messages[0].payload[0].exit.expected, true);
});

test('failed graceful shutdown clears stop intent so a subsequent crash can recover', async () => {
  const harness = createHarness();
  const session = harness.register('stream-1');
  harness.stop = async () => { throw new Error('shutdown failed'); };
  await assert.rejects(harness.api.stopChildToolSessionProcess(session), /shutdown failed/);
  harness.exit({ streamId: 'stream-1', code: 1, signal: null, expected: false });
  assert.equal(harness.messages[0].payload[0].exit.expected, false);
});

test('confirmed termination broadcasts before registry removal when Node close arrives late', async () => {
  const harness = createHarness();
  const session = harness.register('stream-1');
  assert.equal(await harness.api.stopChildToolSessionProcess(session), true);
  assert.equal(harness.messages.length, 2);
  assert.equal(harness.messages[0].payload[0].exit.expected, true);
  assert.equal(harness.api.listChildToolSessions()[0].running, false);
  harness.api.childToolSessions.delete('fixture');
  harness.exit({ streamId: 'stream-1', code: 1, signal: null, expected: true });
  assert.equal(harness.messages.length, 2);
});

test('concurrent session stops share one shutdown and completed stops do not repeat it', async () => {
  const harness = createHarness();
  const session = harness.register('stream-1');
  let finish;
  let calls = 0;
  harness.stop = () => {
    calls += 1;
    return new Promise(resolve => { finish = resolve; });
  };
  const first = harness.api.stopChildToolSessionProcess(session);
  const second = harness.api.stopChildToolSessionProcess(session);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(await harness.api.stopChildToolSessionProcess(session), true);
  assert.equal(calls, 1);
});

test('Main drains all registered sessions before sweeping remaining command owners', async () => {
  const harness = createHarness();
  const failed = harness.register('failed-stream', 'failed');
  const stopped = harness.register('stopped-stream', 'stopped');
  for (const session of [failed, stopped]) {
    session.releaseTimer = setTimeout(() => assert.fail('release timer survived shutdown'), 60_000);
    harness.api.pendingChildToolProcessMessages.set(session.streamId, [{ message: {} }]);
  }
  const calls = [];
  let finish;
  let finishNpm;
  harness.stop = async session => {
    calls.push(`stop:${session.streamId}`);
    assert.equal(session.releaseTimer, null);
    assert.equal(harness.api.pendingChildToolProcessMessages.has(session.streamId), false);
    if (session === failed) throw new Error('bounded shutdown failed');
    await new Promise(resolve => { finish = resolve; });
    harness.active = harness.active.filter(entry => entry.streamId !== session.streamId);
    return true;
  };
  const cleanup = loadMainCleanup({
    stopAllChildToolSessions: () => harness.api.stopAllChildToolSessions(),
    getActiveCmdProcesses: () => harness.active,
    killAllCmdProcesses: async () => {
      calls.push('kill-remaining');
      assert.equal(harness.api.childToolSessions.has('stopped'), false);
      assert.deepEqual(harness.active.map(entry => entry.streamId), ['failed-stream']);
      harness.active = [];
    },
    killAllNpmProcesses: async () => {
      calls.push('kill-npm');
      await new Promise(resolve => { finishNpm = resolve; });
    },
  }, calls);
  const operation = cleanup();
  const repeatedStops = harness.api.stopAllChildToolSessions();
  await Promise.resolve();
  await Promise.resolve();
  const admission = ['begin-window', 'stop-cli', 'begin-command', 'begin-npm', 'begin-auth'];
  assert.deepEqual(calls, [...admission, 'stop:failed-stream', 'stop:stopped-stream']);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [...admission, 'stop:failed-stream', 'stop:stopped-stream', 'kill-remaining', 'kill-npm']);
  finishNpm();
  await Promise.all([operation, repeatedStops]);
  assert.deepEqual(calls, [...admission, 'stop:failed-stream', 'stop:stopped-stream', 'kill-remaining', 'kill-npm', 'release-auth']);
  assert.equal(harness.api.childToolSessions.get('failed'), failed);
  assert.equal(harness.api.pendingChildToolProcessMessages.size, 0);
  assert.equal(failed.releaseTimer, null);
  assert.equal(stopped.releaseTimer, null);
});

test('Main still sweeps remaining owners when the registered-session drain rejects', async () => {
  const calls = [];
  const cleanup = loadMainCleanup({
    stopAllChildToolSessions: async () => { calls.push('drain'); throw new Error('drain failed'); },
    killAllCmdProcesses: async () => { calls.push('cmd'); },
    killAllNpmProcesses: async () => { calls.push('npm'); },
  }, calls);
  await cleanup();
  assert.deepEqual(calls, ['begin-window', 'stop-cli', 'begin-command', 'begin-npm', 'begin-auth', 'drain', 'cmd', 'npm', 'release-auth']);
});

function loadMainCleanup(overrides, calls) {
  const file = path.join(__dirname, 'main.js');
  const source = fs.readFileSync(file, 'utf8');
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declarations = root.statements.filter(node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'cleanupRegisteredChildProcesses');
  assert.equal(declarations.length, 1, 'Main must expose one registered-process cleanup function');
  const context = {
    console: { info() {}, warn() {} },
    beginWindowShutdown: () => calls.push('begin-window'),
    cliBridge: { close: () => calls.push('stop-cli') },
    beginCommandShutdown: () => calls.push('begin-command'),
    beginNpmShutdown: () => calls.push('begin-npm'),
    beginAuthCredentialsShutdown: () => calls.push('begin-auth'),
    releaseAllAuthCredentialsLocks: () => calls.push('release-auth'),
    getActiveCmdProcesses: () => [], getActiveNpmProcesses: () => [],
    getActiveTerminals: () => [], getActiveAilyServicesStreams: () => [],
    killAllTerminals: async () => {}, cancelAllAilyServicesStreams: async () => {},
    connector: { shutdown: async () => {} }, packagedRendererServer: { close: async () => {} },
    ...overrides,
  };
  vm.runInNewContext(declarations[0].getText(root), context, { filename: file });
  return context.cleanupRegisteredChildProcesses;
}

function createHarness() {
  const file = path.join(__dirname, 'window.js');
  const localRequire = createRequire(file);
  const harness = { messages: [], active: [], stop: async () => true };
  const electron = {
    app: { once() {} },
    BrowserWindow: {
      getAllWindows: () => [1, 2].map(id => ({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel, payload) => harness.messages.push({ id, channel, payload }),
        },
      })),
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    module.exports.testApi = { childToolSessions, pendingChildToolProcessMessages, listChildToolSessions,
      isChildToolSessionAlive, stopChildToolSessionProcess, stopAllChildToolSessions };
  `, {
    module,
    require: id => {
      if (id === 'electron') return electron;
      if (id === './cmd') return {
        getActiveCmdProcesses: () => harness.active,
        onCmdProcessMessage() {},
        onCmdProcessExit: listener => { harness.exit = listener; },
      };
      if (id === './child-tool-session-process') return {
        stopChildToolSessionProcess: (...args) => harness.stop(...args),
      };
      return localRequire(id);
    },
    process, console, clearTimeout, setTimeout, __dirname,
  }, { filename: file });
  harness.api = module.exports.testApi;
  harness.register = (streamId, toolId = 'fixture') => {
    const session = { streamId, hostInfo: { pid: process.pid }, owners: new Map(), releaseTimer: null };
    harness.api.childToolSessions.set(toolId, session);
    harness.active.push({ streamId, pid: process.pid });
    return session;
  };
  return harness;
}
