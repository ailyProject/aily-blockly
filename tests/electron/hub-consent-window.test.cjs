const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHubConsentPresenter } = require('../../electron/hub-consent-window');

function fixture() {
  const windows = [], handlers = new Map(), ipcMain = new EventEmitter();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  ipcMain.removeHandler = name => handlers.delete(name);
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.shown = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    showInactive() { this.shown = true; }
    async loadFile(file) { this.file = file; }
    channels() {
      const id = this.options.webPreferences.additionalArguments[0].split('=')[1];
      return { data: `hub-consent:${id}:data`, decision: `hub-consent:${id}:decision` };
    }
    event() { return { sender: this.webContents, senderFrame: this.webContents.mainFrame }; }
  }
  const presenter = createHubConsentPresenter({ BrowserWindow: Window, ipcMain });
  return { presenter, windows, handlers, ipcMain };
}
const input = () => ({ account: '测试账号 B · b@example.test', origin: 'https://hub.aily.pro', expiresAt: Date.now() + 120000 });

test('consent is an independent sandboxed window and only the exact frame can approve it', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const pending = f.presenter.confirm(input()), window = f.windows[0], channels = window.channels();
  assert.equal(window.options.modal, false); assert.equal(window.options.parent, undefined);
  assert.equal(window.options.webPreferences.sandbox, true); assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true); assert.equal(window.options.webPreferences.webSecurity, true);
  window.emit('ready-to-show'); assert.equal(window.shown, true);
  assert.equal(f.handlers.get(channels.data)(window.event()).account, input().account);
  assert.equal(f.handlers.get(channels.data)({ sender: window.webContents, senderFrame: {} }), null);
  f.ipcMain.emit(channels.decision, { sender: window.webContents, senderFrame: {} }, true);
  assert.equal(window.isDestroyed(), false);
  f.ipcMain.emit(channels.decision, window.event(), true);
  assert.equal(await pending, true); assert.equal(window.isDestroyed(), true);
  assert.equal(f.handlers.size, 0); assert.equal(f.ipcMain.listenerCount(channels.decision), 0);
});

test('closing, timeout and explicit cancellation never approve', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const closing = f.presenter.confirm(input()); f.windows[0].destroy(); assert.equal(await closing, false);
  const expired = f.presenter.confirm({ ...input(), expiresAt: Date.now() + 10 }); assert.equal(await expired, false);
  const cancelled = f.presenter.confirm(input()); f.presenter.cancel(); assert.equal(await cancelled, false);
});

test('consent cannot navigate away, open another window or attach a webview', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const pending = f.presenter.confirm(input()), window = f.windows[0]; let prevented = 0;
  window.webContents.emit('will-navigate', { preventDefault: () => prevented++ });
  window.webContents.emit('will-attach-webview', { preventDefault: () => prevented++ });
  assert.equal(prevented, 2); assert.deepEqual(window.openHandler({ url: 'https://evil.example' }), { action: 'deny' });
  window.webContents.emit('render-process-gone'); assert.equal(await pending, false);
});

test('a new prompt releases the previous prompt and does not reuse its reply channel', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const old = f.presenter.confirm(input()), first = f.windows[0];
  const next = f.presenter.confirm(input()), second = f.windows[1];
  assert.equal(await old, false); assert.notEqual(first.channels().decision, second.channels().decision);
  f.ipcMain.emit(first.channels().decision, first.event(), true); assert.equal(second.isDestroyed(), false);
  f.ipcMain.emit(second.channels().decision, second.event(), false); assert.equal(await next, false);
});
