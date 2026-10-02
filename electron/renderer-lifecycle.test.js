'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererCommandGate, shouldBeginRendererGeneration } = require('./renderer-lifecycle');

test('same-document navigations do not start a renderer generation', () => {
  assert.equal(shouldBeginRendererGeneration({ isMainFrame: true, isSameDocument: true }), false);
  assert.equal(shouldBeginRendererGeneration({ isMainFrame: true, isSameDocument: false }), true);
});

test('a command waits until the renderer handshake completes', async () => {
  const gate = createRendererCommandGate();
  let ready = false;
  const pending = gate.wait(1000, undefined, () => (ready ? 'ready' : ''));
  ready = true;
  gate.notify();
  assert.equal(await pending, 'ready');
});

test('a closed window releases the waiter without using the whole timeout', async () => {
  const gate = createRendererCommandGate();
  let closed = false;
  const started = Date.now();
  const pending = gate.wait(5000, undefined, () => (closed ? 'closed' : ''));
  closed = true;
  gate.notify();
  assert.equal(await pending, 'closed');
  assert.ok(Date.now() - started < 1000);
});

test('cancellation settles the waiter', async () => {
  const gate = createRendererCommandGate();
  const signal = AbortSignal.abort();
  assert.equal(await gate.wait(5000, signal, () => ''), 'aborted');
});

test('the startup wait is bounded when the renderer never becomes ready', async () => {
  const gate = createRendererCommandGate();
  const started = Date.now();
  assert.equal(await gate.wait(30, undefined, () => ''), 'timeout');
  assert.ok(Date.now() - started < 1000);
});
