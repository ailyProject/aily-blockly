'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_MAX_MESSAGE_BYTES,
  normalizeProcessMessage,
  normalizeProcessMessagePortConfig,
} = require('./child-process-message-port');

test('normalizes one declarative node IPC message port', () => {
  assert.deepEqual(
    normalizeProcessMessagePortConfig({ transport: 'node-ipc-v1' }),
    {
      transport: 'node-ipc-v1',
      maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
    },
  );
  assert.equal(normalizeProcessMessagePortConfig(undefined), null);
});

test('rejects unsupported transports and unsafe message budgets', () => {
  assert.throws(
    () => normalizeProcessMessagePortConfig({ transport: 'simulator-ipc' }),
    /node-ipc-v1/,
  );
  assert.throws(
    () => normalizeProcessMessagePortConfig({
      transport: 'node-ipc-v1',
      maxMessageBytes: 32,
    }),
    /between/,
  );
});

test('accepts bounded JSON records and returns a detached clone', () => {
  const source = {
    type: 'provider.request',
    nested: { sequence: 1 },
    values: [true, null, 'ok'],
  };
  const normalized = normalizeProcessMessage(source, 4096);
  assert.deepEqual(normalized.message, source);
  assert.notEqual(normalized.message, source);
  assert.ok(normalized.sizeBytes > 0);
});

test('rejects cycles, non-JSON values and oversized messages', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => normalizeProcessMessage(cyclic), /cycle/);
  assert.throws(
    () => normalizeProcessMessage({ callback() {} }),
    /non-JSON/,
  );
  assert.throws(
    () => normalizeProcessMessage({ body: 'x'.repeat(2048) }, 1024),
    /byte limit/,
  );
});
