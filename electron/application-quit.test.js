'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createApplicationQuitCoordinator } = require('./application-quit');
const settle = () => new Promise(resolve => setImmediate(resolve));

function host(options = {}) {
  const app = new EventEmitter(), ipcMain = new EventEmitter(), sender = new EventEmitter();
  const sent = [], calls = [];
  sender.mainFrame = {};
  sender.isDestroyed = () => false; sender.isCrashed = () => false;
  sender.send = (channel, message) => sent.push({ channel, message });
  let win = { webContents: sender, isDestroyed: () => false };
  app.quit = () => calls.push('quit');
  const coordinator = createApplicationQuitCoordinator({ app, ipcMain, getWindow: () => win,
    canConfirm: () => true, confirmUnavailable: async () => false,
    cleanup: async () => calls.push('cleanup'), onError: error => calls.push(error.message), ...options });
  return { app, sender, sent, calls, coordinator, replace: value => { win = value; },
    checking() { ipcMain.emit('window-close-checking', { sender, senderFrame: sender.mainFrame }, sent.at(-1).message); },
    begin() { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); return prevented; },
    reply(allowed, overrides = {}, event = { sender, senderFrame: sender.mainFrame }) {
      ipcMain.emit('window-close-confirmed', event, { requestId: sent.at(-1)?.message.requestId, allowed, ...overrides });
    },
  };
}

test('repeated quit asks once and cancellation leaves every cleanup resource intact', async () => {
  const h = host();
  assert.equal(h.begin(), true); h.begin(); h.begin();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].channel, 'window-close-request');
  h.reply(false); await settle();
  assert.deepEqual(h.calls, []); assert.equal(h.coordinator.canClose(), false);
  h.begin(); assert.equal(h.sent.length, 2);
  assert.notEqual(h.sent[0].message.requestId, h.sent[1].message.requestId);
  h.reply(true); await settle(); assert.deepEqual(h.calls, ['cleanup', 'quit']);
  assert.equal(h.begin(), false);
});

test('cleanup begins only after approval, runs once, and must finish before native close', async () => {
  let finish, stops = 0;
  const h = host({ cleanup: () => { stops++; return new Promise(resolve => { finish = resolve; }); } });
  h.begin(); await settle(); assert.equal(stops, 0);
  h.reply(true); h.reply(true); h.begin(); await settle();
  assert.equal(stops, 1); assert.equal(h.coordinator.canClose(), false); assert.deepEqual(h.calls, []);
  finish(); await settle(); assert.equal(h.coordinator.canClose(), true); assert.deepEqual(h.calls, ['quit']);
});

test('only the matching main-frame boolean answer can approve quit', async () => {
  const h = host(); h.begin();
  h.reply(true, {}, { sender: {}, senderFrame: h.sender.mainFrame });
  h.reply(true, {}, { sender: h.sender, senderFrame: {} });
  h.reply(true, { requestId: 'forged' }); h.reply('true'); h.reply(undefined);
  await settle(); assert.deepEqual(h.calls, []);
  h.reply(false); h.begin();
  h.reply(true, { requestId: h.sent[0].message.requestId });
  await settle(); assert.deepEqual(h.calls, []);
  h.reply(true); await settle(); assert.deepEqual(h.calls, ['cleanup', 'quit']);
});

for (const event of ['navigation', 'render-process-gone', 'destroyed']) test(`${event} invalidates old answers and removes listeners`, async () => {
  const h = host(); h.begin();
  if (event === 'navigation') h.sender.emit('did-start-navigation', {}, 'new', false, true);
  else h.sender.emit(event);
  h.reply(true); await settle(); assert.deepEqual(h.calls, []);
  for (const name of ['did-start-navigation', 'render-process-gone', 'destroyed']) assert.equal(h.sender.listenerCount(name), 0);
  h.begin(); h.reply(true); await settle(); assert.deepEqual(h.calls, ['cleanup', 'quit']);
});

test('subframe and in-place navigation do not invalidate an editor confirmation', async () => {
  const h = host(); h.begin();
  h.sender.emit('did-start-navigation', {}, 'iframe', false, false);
  h.sender.emit('did-start-navigation', {}, '#route', true, true);
  h.reply(true); await settle(); assert.deepEqual(h.calls, ['cleanup', 'quit']);
});

test('a replaced main window cannot be closed by the old window answer', async () => {
  const h = host(); h.begin(); h.replace({ webContents: {}, isDestroyed: () => false });
  h.reply(true); await settle(); assert.deepEqual(h.calls, []);
});

for (const allowed of [false, true]) test(`unavailable renderer requires explicit native confirmation (${allowed})`, async () => {
  let respond, prompts = 0;
  const h = host({ canConfirm: () => false, confirmUnavailable: () => { prompts++; return new Promise(resolve => { respond = resolve; }); } });
  h.begin(); h.begin(); await settle(); assert.equal(prompts, 1); assert.equal(h.sent.length, 0); assert.deepEqual(h.calls, []);
  respond(allowed); await settle(); assert.deepEqual(h.calls, allowed ? ['cleanup', 'quit'] : []);
});

test('crashed renderer uses native confirmation even if an earlier readiness flag is still true', async () => {
  let prompts = 0;
  const h = host({ confirmUnavailable: async () => { prompts++; return false; } });
  h.sender.isCrashed = () => true; h.begin(); await settle();
  assert.equal(prompts, 1); assert.equal(h.sent.length, 0); assert.deepEqual(h.calls, []);
});

test('confirmation errors cancel and permit a new attempt, never start cleanup', async () => {
  const h = host({ canConfirm: () => false, confirmUnavailable: async () => { throw new Error('dialog failed'); } });
  h.begin(); await settle(); h.begin(); await settle();
  assert.deepEqual(h.calls, ['dialog failed', 'dialog failed']);
});

test('no main window at startup still drains resources without a renderer round trip', async () => {
  const h = host(); h.replace(null); h.begin(); await settle();
  assert.equal(h.sent.length, 0); assert.deepEqual(h.calls, ['cleanup', 'quit']);
});

test('lost delivery offers explicit native cancellation instead of hanging or auto-closing', async () => {
  let prompts = 0;
  const h = host({ deliveryTimeoutMs: 10, confirmUnavailable: async () => { prompts++; return false; } });
  h.begin(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(prompts, 1); assert.deepEqual(h.calls, []);
  h.reply(true); await settle(); assert.deepEqual(h.calls, []);
});

test('delivery acknowledgement stops the timer while the user decides; an actual hang still offers native cancellation', async () => {
  let prompts = 0;
  const h = host({ deliveryTimeoutMs: 10, confirmUnavailable: async () => { prompts++; return false; } });
  h.begin(); h.checking(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(prompts, 0); assert.deepEqual(h.calls, []);
  h.sender.emit('unresponsive'); await settle(); assert.equal(prompts, 1); assert.deepEqual(h.calls, []);
});

test('cleanup rejection is reported and does not leave a permanently half-quit host', async () => {
  const h = host({ cleanup: async () => { throw new Error('cleanup failed'); } });
  h.begin(); h.reply(true); await settle();
  assert.deepEqual(h.calls, ['cleanup failed', 'quit']); assert.equal(h.begin(), false);
});
