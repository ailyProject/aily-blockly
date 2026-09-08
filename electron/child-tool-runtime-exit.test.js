'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
    module.exports.testApi = { childToolSessions, listChildToolSessions, isChildToolSessionAlive, stopChildToolSessionProcess };
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
  harness.register = streamId => {
    const session = { streamId, hostInfo: { pid: process.pid }, owners: new Map(), releaseTimer: null };
    harness.api.childToolSessions.set('fixture', session);
    harness.active = [{ streamId, pid: process.pid }];
    return session;
  };
  return harness;
}
