'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getSafeShutdownUrl,
  stopChildToolSessionProcess,
} = require('./child-tool-session-process');

test('uses same-origin loopback shutdown before touching the process tree', async () => {
  const calls = [];
  let streamAlive = true;
  let hostAlive = true;
  const result = await stopChildToolSessionProcess(fixtureSession(), {
    fetchImpl: async (_url, options) => {
      calls.push(`fetch:${options.method}`);
      streamAlive = false;
      hostAlive = false;
      return { ok: true };
    },
    getActiveProcesses: () => streamAlive ? [{ streamId: 'stream-1' }] : [],
    gracefulShutdownWaitMs: 20,
    isPidAlive: () => hostAlive,
    killProcessTree: async () => calls.push('kill-tree'),
    killStream: () => calls.push('kill-stream'),
    pollIntervalMs: 1,
  });

  assert.equal(result, true);
  assert.deepEqual(calls, ['fetch:POST']);
});

test('falls back to stream and process-tree kill only after graceful shutdown fails', async () => {
  const calls = [];
  let hostAlive = true;
  const result = await stopChildToolSessionProcess(fixtureSession(), {
    fetchImpl: async (_url, options) => {
      calls.push(`fetch:${options.method}`);
      return { ok: false };
    },
    getActiveProcesses: () => [{ streamId: 'stream-1' }],
    isPidAlive: () => hostAlive,
    killProcessTree: async () => {
      calls.push('kill-tree');
      hostAlive = false;
    },
    killStream: () => {
      calls.push('kill-stream');
      return true;
    },
  });

  assert.equal(result, true);
  assert.deepEqual(calls, ['fetch:POST', 'kill-stream', 'kill-tree']);
});

test('rejects a remote or cross-origin shutdown URL', () => {
  assert.equal(getSafeShutdownUrl({
    hostInfo: {
      url: 'http://127.0.0.1:4100',
      shutdownUrl: 'https://example.com/api/shutdown?token=secret',
    },
  }), '');
  assert.equal(getSafeShutdownUrl({
    hostInfo: {
      url: 'http://127.0.0.1:4100',
      shutdownUrl: 'http://127.0.0.1:4200/api/shutdown?token=secret',
    },
  }), '');
});

test('bounds a stalled graceful request before falling back to kill', async () => {
  const calls = [];
  let hostAlive = true;
  const result = await stopChildToolSessionProcess(fixtureSession(), {
    fetchImpl: async () => await new Promise(() => undefined),
    getActiveProcesses: () => [{ streamId: 'stream-1' }],
    isPidAlive: () => hostAlive,
    killProcessTree: async () => {
      calls.push('kill-tree');
      hostAlive = false;
    },
    killStream: async () => calls.push('kill-stream'),
    shutdownRequestTimeoutMs: 5,
  });

  assert.equal(result, true);
  assert.deepEqual(calls, ['kill-stream', 'kill-tree']);
});

function fixtureSession() {
  return {
    streamId: 'stream-1',
    hostInfo: {
      url: 'http://127.0.0.1:4100',
      shutdownUrl: 'http://127.0.0.1:4100/api/shutdown?token=secret',
      pid: 5001,
    },
  };
}
