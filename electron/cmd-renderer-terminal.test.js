'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const test = require('node:test');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ real = false, workspace, deliveryThrows = false } = {}) {
  const handlers = new Map(), messages = [], children = [], delivery = [];
  let destroyed = false;
  const sender = { id: 1, mainFrame: {}, isDestroyed: () => destroyed,
    send: (channel, payload) => messages.push({ channel, payload }) };
  const context = { module: { exports: {} }, process, setTimeout, clearTimeout,
    console: { log() {}, info() {}, warn() {}, error() {} }, require: name => {
      if (name === 'electron') return { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } };
      if (name === './platform') return { isLinux: true };
      if (name === './build-workspace-supervisor') return { createBuildWorkspaceSupervisor: () => workspace };
      if (name === './child-process-message-port') {
        const original = require(name);
        // VM-created delivery config crosses a fixture realm. Recreate JSON
        // in the original normalizer's realm, as real IPC does in Main; retain
        // its exact plain-record and budget validation unchanged.
        return { ...original, normalizeProcessMessagePortConfig: value =>
          original.normalizeProcessMessagePortConfig(value == null ? value : JSON.parse(JSON.stringify(value))) };
      }
      if (name === 'child_process') return { spawn: (...args) => {
        const child = real ? spawn(...args) : Object.assign(new EventEmitter(), { pid: 12345 + children.length,
          connected: true, send() {}, stdio: [new EventEmitter(), new EventEmitter(), new EventEmitter()] });
        if (!real) [child.stdin, child.stdout, child.stderr] = child.stdio;
        children.push(child); return child;
      } };
      return require(name);
    } };
  const filename = require.resolve('./cmd');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const api = context.module.exports;
  api.registerCmdHandlers(null, { buildDeliveryAuthority: { invalidate() {}, begin: async () => ({ handle: 'test-handle',
    onMessage() {}, abandon() {}, onExit: (...args) => { delivery.push(args); if (deliveryThrows) throw Error('test observer failure'); } }) } });
  return { api, handlers, sender, messages, children, delivery, destroy: () => { destroyed = true; },
    run: options => handlers.get('cmd-run')({ sender, senderFrame: sender.mainFrame }, {
      command: process.execPath, args: [], shellProfile: false,
      messagePort: { transport: 'node-ipc-v1', maxMessageBytes: 4096 }, ...options,
    }),
    terminals: stream => messages.filter(({ channel, payload }) => channel === 'cmd-data-' + stream
      && ['terminal', 'close'].includes(payload.type)),
    complete(child, code = 0, signal = null) {
      child.emit('exit', code, signal); child.emit('disconnect');
      for (const pipe of child.stdio) pipe?.emit('close');
    } };
}

test('registered Renderer fallback uses the sole command observer and preserves exact terminal metadata', async () => {
  const f = fixture(); assert.equal((await f.run({ streamId: 'renderer' })).success, true);
  const child = f.children[0];
  assert.equal(child.listenerCount('exit'), 1); assert.equal(child.listenerCount('close'), 1);
  child.stdout.emit('data', Buffer.from('ready')); child.stderr.emit('data', Buffer.from('diagnostic'));
  f.complete(child, 9); await tick();
  assert.equal(f.api.getCmdProcess('renderer'), undefined); assert.equal(f.terminals('renderer').length, 1);
  const event = f.terminals('renderer')[0];
  assert.equal(event.payload.type, 'terminal'); assert.equal(event.payload.code, 9);
  assert.equal(event.payload.terminal.kind, 'exit-and-stdio-closed'); assert.equal(event.payload.terminal.closeObserved, false);
  assert.equal(event.payload.expected, false); assert.equal(event.channel, 'cmd-data-renderer');
  assert.deepEqual(f.messages.slice(0, 2).map(value => value.payload.type), ['stdout', 'stderr']);
  child.emit('close', 9, null); assert.equal(f.terminals('renderer').length, 1);
});

test('real close retains legacy type and fallback cannot notify a different or reused stream', async () => {
  const f = fixture(); await f.run({ streamId: 'one' }); await f.run({ streamId: 'two' });
  f.children[0].emit('close', 0, null);
  assert.equal(f.terminals('one')[0].payload.type, 'close');
  assert.equal(f.terminals('one')[0].payload.terminal.closeObserved, true);
  assert.equal(f.terminals('two').length, 0);
  await f.run({ streamId: 'one' });
  f.children[0].emit('close', 1, null);
  assert.equal(f.terminals('one').length, 1); assert.equal(f.api.getCmdProcess('one'), f.children[2]);
  f.complete(f.children[1]); f.complete(f.children[2]); await tick();
  assert.equal(f.terminals('one').length, 2); assert.equal(f.terminals('two').length, 1);
});

test('missing a real pipe close retains registration and does not broadcast a terminal', async () => {
  const f = fixture(); await f.run({ streamId: 'pending' }); const child = f.children[0];
  child.emit('exit', 0, null); child.emit('disconnect'); child.stdout.emit('close'); child.stderr.emit('close');
  await tick(); assert.equal(f.terminals('pending').length, 0); assert.equal(f.api.getCmdProcess('pending'), child);
  child.stdin.emit('close'); await tick(); assert.equal(f.terminals('pending').length, 1);
});

test('destroyed Renderer does not block manager termination or receive late terminal output', async () => {
  const f = fixture(); await f.run({ streamId: 'destroyed' }); f.destroy();
  f.complete(f.children[0]); await tick();
  assert.equal(f.api.getCmdProcess('destroyed'), undefined); assert.equal(f.terminals('destroyed').length, 0);
});

for (const retained of [false, true]) test(`delivery consumes the same physical terminal with ${retained ? 'retained' : 'released'} workspace responsibility`, async () => {
  const f = fixture(retained ? { workspace: { environment: {}, canReleaseResources: () => false } } : {});
  const reply = await f.run({ streamId: 'delivery', buildWorkspace: '/test', buildDeliveryRequest: '/test/request' });
  assert.equal(reply.buildDeliveryHandle, 'test-handle'); f.complete(f.children[0]); await tick();
  assert.deepEqual(f.delivery, [[0, null, retained]]); assert.equal(f.terminals('delivery').length, 1);
  assert.equal(Boolean(f.api.getCmdProcess('delivery')), retained);
  f.children[0].emit('close', 0, null); assert.equal(f.delivery.length, 1);
});

test('a delivery observer failure does not suppress the separately subscribed Renderer terminal', async () => {
  const f = fixture({ deliveryThrows: true });
  await f.run({ streamId: 'separate', buildDeliveryRequest: '/test/request' });
  f.complete(f.children[0]); await tick(); assert.equal(f.delivery.length, 1); assert.equal(f.terminals('separate').length, 1);
});

test('actual registered Node IPC disconnect reaches Renderer without relying on ChildProcess close', { timeout: 8000 }, async t => {
  const f = fixture({ real: true });
  const reply = await f.run({ streamId: 'actual', args: ['-e', `
    process.on('disconnect', () => {}); process.stdout.write('actual-ready');
  `] });
  assert.equal(reply.success, true); const child = f.children[0];
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const deadline = Date.now() + 5000;
  while (!f.messages.some(value => value.payload.data?.includes('actual-ready'))) {
    assert.ok(Date.now() < deadline); await tick();
  }
  child.disconnect();
  while (!f.terminals('actual').length) { assert.ok(Date.now() < deadline); await tick(); }
  const event = f.terminals('actual')[0].payload;
  assert.equal(event.code, 0); assert.equal(event.signal, null);
  assert.equal(event.type, event.terminal.kind === 'close' ? 'close' : 'terminal');
  assert.equal(event.terminal.closeObserved, event.type === 'close');
  assert.equal(f.api.getCmdProcess('actual'), undefined);
  t.diagnostic(JSON.stringify({ registeredPid: child.pid, rendererTerminal: event,
    NodeBusinessCleanupAcknowledged: false, scope: 'Actual Node unit ingress, not Electron/Angular acceptance' }));
});
