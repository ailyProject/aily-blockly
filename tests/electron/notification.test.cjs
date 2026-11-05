const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createNotificationApi } = require('../../electron/notification-preload');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ platform = 'win32', supported = true, showError } = {}) {
  let activate;
  const weak = [], handlers = new Map(), warnings = [], app = new EventEmitter();
  class NativeNotification extends EventEmitter {
    static isSupported() { return supported; }
    constructor(options) { super(); this.options = options; this.closes = 0; weak.push(new WeakRef(this)); }
    show() { if (showError) throw new Error(showError); this.emit('show'); }
    close() { this.closes++; this.emit('close'); }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../electron/notification.js'), 'utf8'), {
    module, process: { platform }, console: { warn: (...args) => warnings.push(args), error() {} },
    require(name) {
      if (name === 'electron') return { Notification: NativeNotification, app,
        BrowserWindow: { fromWebContents: sender => sender.window },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
      if (name === './notification-activation') return {
        createActivationServer({ product, onActivate }) { activate = onActivate; return { ready: Promise.resolve(), url: id => `${product === 'coder' ? 'acis' : 'abis'}://notification/11111111-1111-4111-8111-111111111111/${id}`, close() {} }; },
        createWindowsToastXml: require('../../electron/notification-activation').createWindowsToastXml,
      };
      if (name === './window-attention') return { requestWindowAttention() {} };
      return require(name);
    },
  });
  function window() {
    const w = new EventEmitter(); w.destroyed = false; w.calls = [];
    w.isDestroyed = () => w.destroyed; w.isMinimized = () => true;
    for (const name of ['restore', 'show', 'focus', 'flashFrame']) w[name] = () => w.calls.push(name);
    return w;
  }
  return { api: module.exports, app, handlers, weak, warnings, window, activate: id => activate(id), latest: () => weak.at(-1).deref() };
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: native banner click restores its owner and returns one receipt`, async () => {
    const h = harness({ platform }), w = h.window(), events = [];
    const promise = h.api.showNotification({ title: 'Build', body: 'done', urgency: 'critical' }, w, e => events.push(e));
    await tick();
    assert.equal(h.latest().options.urgency, platform === 'linux' ? 'critical' : undefined);
    h.latest().emit('click');
    assert.equal((await promise).event, 'click');
    assert.deepEqual(w.calls, ['restore', 'show', 'focus', 'flashFrame']);
    assert.deepEqual(events.map(e => e.event), ['show', 'click']);
    assert.equal(w.listenerCount('closed'), 0);
  });
}

test('Windows keeps a pending IPC notification alive before its first callback', { skip: !global.gc }, async () => {
  const h = harness(), w = h.window(); h.api.registerNotificationHandlers(w);
  const pending = h.handlers.get('notification-show')({ sender: { window: w, isDestroyed: () => false, send() {} } }, {});
  for (let i = 0; i < 4; i++) { await tick(); global.gc(); }
  assert.ok(h.weak[0].deref(), 'pending native JS delegate was collected');
  h.latest().emit('click');
  assert.equal((await pending).result.event, 'click');
});

test('Windows keeps a dismissed notification alive across GC for history activation', { skip: !global.gc }, async () => {
  const h = harness(), w = h.window(), events = [];
  const promise = h.api.showNotification({}, w, e => events.push(e));
  await tick(); h.latest().emit('close');
  const receipt = await promise;
  for (let i = 0; i < 4; i++) { await tick(); global.gc(); }
  assert.ok(h.weak[0].deref(), 'native JS delegate was collected after close');
  h.latest().emit('click');
  assert.equal(events.at(-1).event, 'click');
  assert.equal(events.at(-1).notificationId, receipt.notificationId);
  assert.deepEqual(w.calls, ['restore', 'show', 'focus', 'flashFrame']);
  assert.equal(h.latest().listenerCount('click'), 0);
});

test('history click is sent after the initial IPC close reply, to the requesting renderer only', async () => {
  const h = harness(), w = h.window(), fallback = h.window(), sent = [];
  h.api.registerNotificationHandlers(fallback);
  const sender = { window: w, isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
  const promise = h.handlers.get('notification-show')({ sender }, { title: 'Coder' });
  await tick(); h.latest().emit('close');
  const receipt = await promise;
  assert.equal(receipt.success, true); assert.equal(receipt.result.event, 'close');
  h.latest().emit('click');
  assert.deepEqual(sent.map(e => e.payload.event), ['show', 'close', 'click']);
  assert.ok(sent.every(e => e.channel === 'notification-event'));
  assert.ok(sent.every(e => e.payload.notificationId === receipt.result.notificationId));
  assert.deepEqual(fallback.calls, []);
});

test('a destroyed sender cannot prevent restoration or the click receipt', async () => {
  const h = harness(), w = h.window(); h.api.registerNotificationHandlers(w);
  let destroyed = false;
  const promise = h.handlers.get('notification-show')({ sender: { window: w, isDestroyed: () => destroyed,
    send() { assert.equal(destroyed, false); } } }, {});
  destroyed = true; await tick(); h.latest().emit('click');
  assert.equal((await promise).result.event, 'click');
  assert.ok(w.calls.includes('focus'));
});

test('window restoration errors do not swallow a native activation', async () => {
  const h = harness(), w = h.window(); w.restore = () => { throw new Error('window changed'); };
  const promise = h.api.showNotification({}, w); await tick(); h.latest().emit('click');
  assert.equal((await promise).event, 'click'); assert.equal(h.warnings.length, 1);
});

test('closing an owner removes only its history, with one lifecycle listener per owner', async () => {
  const h = harness(), first = h.window(), second = h.window();
  const pending = [h.api.showNotification({}, first), h.api.showNotification({}, first), h.api.showNotification({}, second)];
  await tick();
  assert.equal(first.listenerCount('closed'), 1);
  first.destroyed = true; first.emit('closed');
  assert.equal((await pending[0]).reason, 'window-closed');
  assert.equal((await pending[1]).reason, 'window-closed');
  assert.equal(h.weak[0].deref().closes, 1); assert.equal(h.weak[1].deref().closes, 1);
  assert.equal(h.weak[2].deref().closes, 0);
  h.latest().emit('click'); await pending[2];
  assert.ok(second.calls.includes('focus'));
});

test('history limit removes the OS entry before dropping its callbacks', async () => {
  const h = harness(), pending = [];
  for (let i = 0; i < 129; i++) pending.push(h.api.showNotification({ body: String(i) }));
  assert.equal((await pending[0]).reason, 'history-limit');
  assert.equal(h.weak[0].deref().closes, 1); assert.equal(h.weak[0].deref().listenerCount('click'), 0);
  assert.equal(h.weak[1].deref().closes, 0);
  await tick(); h.app.emit('will-quit'); await Promise.all(pending);
});

test('application exit settles outstanding calls and removes native entries', async () => {
  const h = harness(), w = h.window(), p = h.api.showNotification({}, w);
  await tick(); h.app.emit('will-quit'); assert.equal((await p).reason, 'app-quit');
  assert.equal(h.latest().closes, 1); assert.equal(w.listenerCount('closed'), 0);
});

test('unsupported notifications reject without constructing a native entry', async () => {
  const h = harness({ supported: false });
  await assert.rejects(h.api.showNotification({}), /不支持/); assert.equal(h.weak.length, 0);
});

test('synchronous show failures stay failures rather than resolving close', async () => {
  const h = harness({ showError: 'toast unavailable' });
  await assert.rejects(h.api.showNotification({}), /toast unavailable/);
  assert.equal(h.latest().closes, 1); assert.equal(h.latest().listenerCount('click'), 0);
});

test('native failed(event, message) preserves the diagnostic and cleans up', async () => {
  const h = harness(); h.api.registerNotificationHandlers(h.window());
  const pending = h.handlers.get('notification-show')({ sender: { window: null, isDestroyed: () => false, send() {} } }, {});
  await tick(); h.latest().emit('failed', {}, 'toast rejected');
  const result = await pending; assert.equal(result.success, false); assert.equal(result.error, 'toast rejected');
  assert.equal(h.latest().listenerCount('click'), 0);
});

test('preload forwards persistent events without exposing Electron event objects, and unsubscribes independently', async () => {
  const ipc = new EventEmitter(), invokes = [], a = [], b = [];
  ipc.invoke = async (...args) => { invokes.push(args); return { success: true }; };
  const api = createNotificationApi(ipc);
  const stop = api.onEvent(e => a.push(e)); api.onEvent(e => b.push(e));
  await api.show({ title: 'compile' }); await api.isSupported();
  const payload = { notificationId: 'history-1', event: 'click' };
  ipc.emit('notification-event', { secret: 'native event' }, payload);
  stop(); stop(); ipc.emit('notification-event', {}, payload);
  assert.deepEqual(a, [payload]); assert.deepEqual(b, [payload, payload]);
  assert.deepEqual(invokes, [['notification-show', { title: 'compile' }], ['notification-is-supported']]);
  assert.throws(() => api.onEvent(null), /监听器/);
});

// 历史点击由 OS 协议回调驱动，测试不再假设 Electron 会在 close 后再发原生 click。
test('Windows protocol activation restores the exact owner after the original close reply, once', async () => {
  const h = harness(), owner = h.window(), events = [];
  h.api.registerNotificationHandlers(owner, 'coder');
  const pending = h.api.showNotification({ title: 'Build & done' }, owner, e => events.push(e));
  await tick();
  assert.match(h.latest().options.toastXml, /activationType="protocol"/);
  assert.match(h.latest().options.toastXml, /acis:\/\/notification\//);
  h.latest().emit('close');
  const receipt = await pending;
  assert.equal(receipt.event, 'close');
  assert.equal(h.activate(receipt.notificationId), true);
  assert.equal(h.activate(receipt.notificationId), false);
  assert.deepEqual(events.map(e => e.event), ['show', 'close', 'click']);
  assert.deepEqual(owner.calls, ['restore', 'show', 'focus', 'flashFrame']);
});
