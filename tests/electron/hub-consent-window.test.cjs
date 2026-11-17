const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHubConsentPresenter } = require('../../electron/hub-consent-window');

function fixture() {
  const views = [], handlers = new Map(), ipcMain = new EventEmitter(), window = new EventEmitter();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  ipcMain.removeHandler = name => handlers.delete(name);
  window.destroyed = false; window.bounds = { x: 120, y: 70, width: 1200, height: 780 };
  window.isDestroyed = () => window.destroyed; window.isMinimized = () => false;
  window.getContentBounds = () => window.bounds; window.show = () => {};
  window.enabled = true; window.isEnabled = () => window.enabled; window.setEnabled = enabled => { window.enabled = enabled; };
  window.focusable = true; window.isFocusable = () => window.focusable;
  window.focusRestored = 0; window.webContents = { focus: () => window.focusRestored++ };
  window.contentView = { children: [], addChildView(view) { this.children.push(view); },
    removeChildView(view) { this.children = this.children.filter(item => item !== view); } };
  class View extends EventEmitter {
    constructor(options) {
      super();
      this.options = options; this.visible = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.destroyed = false;
      this.webContents.messages = [];
      this.webContents.send = (...message) => this.webContents.messages.push(message);
      this.webContents.isDestroyed = () => this.webContents.destroyed;
      this.webContents.close = () => { this.webContents.destroyed = true; this.webContents.emit('destroyed'); };
      this.webContents.focused = false;
      this.webContents.focus = () => { this.webContents.focused = true; };
      this.webContents.isFocused = () => this.webContents.focused;
      this.webContents.loadFile = async file => { this.file = file; };
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      views.push(this);
    }
    isDestroyed() { return this.destroyed === true; }
    destroy() { this.destroyed = true; this.webContents.close(); this.emit('closed'); }
    show() { this.visible = true; }
    focus() { this.webContents.focus(); }
    setMenu(menu) { this.menu = menu; }
    channels() {
      const id = this.options.webPreferences.additionalArguments[0].split('=')[1];
      return { data: `hub-consent:${id}:data`, decision: `hub-consent:${id}:decision` };
    }
    event() { return { sender: this.webContents, senderFrame: this.webContents.mainFrame }; }
  }
  const prepareChrome = (_child, owner) => {
    owner.focusable = false;
    return { restore() { owner.focusable = true; }, setTheme() {} };
  };
  const presenter = createHubConsentPresenter({ window, BrowserWindow: View, ipcMain, prepareChrome });
  return { presenter, window, views, handlers, ipcMain };
}
const input = () => ({ account: '测试账号 B · b@example.test', origin: 'https://hub.aily.pro', expiresAt: Date.now() + 120000 });

test('consent is a modal child of its host and only its exact sandboxed frame can approve', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const pending = f.presenter.confirm(input()), view = f.views[0], channels = view.channels();
  assert.equal(view.options.parent, f.window); assert.equal(view.options.modal, process.platform !== 'darwin');
  assert.equal(view.options.frame, true); assert.equal(view.options.transparent, false);
  assert.equal(view.options.titleBarStyle, 'default'); assert.equal(view.options.closable, true);
  assert.equal(view.options.skipTaskbar, true); assert.deepEqual(f.window.contentView.children, []);
  assert.equal(view.options.webPreferences.sandbox, true); assert.equal(view.options.webPreferences.nodeIntegration, false);
  assert.equal(view.options.webPreferences.contextIsolation, true); assert.equal(view.options.webPreferences.webSecurity, true);
  assert.equal(view.visible, false); view.emit('ready-to-show'); assert.equal(view.visible, true);
  assert.equal(f.handlers.get(channels.data)(view.event()).account, input().account);
  assert.equal(f.handlers.get(channels.data)({ sender: view.webContents, senderFrame: {} }), null);
  f.ipcMain.emit(channels.decision, { sender: view.webContents, senderFrame: {} }, true);
  assert.equal(view.webContents.isDestroyed(), false);
  f.ipcMain.emit(channels.decision, view.event(), true);
  assert.equal(await pending, true); assert.equal(view.webContents.isDestroyed(), true);
  assert.deepEqual(f.window.contentView.children, []);
  assert.equal(f.window.focusRestored, 1);
  assert.equal(f.window.isEnabled(), true);
  assert.equal(f.window.isFocusable(), true);
  assert.equal(f.handlers.size, 0); assert.equal(f.ipcMain.listenerCount(channels.decision), 0);
});

test('closing, timeout and explicit cancellation never approve', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const closing = f.presenter.confirm(input()); f.views[0].emit('closed'); assert.equal(await closing, false);
  const expired = f.presenter.confirm({ ...input(), expiresAt: Date.now() + 10 }); assert.equal(await expired, false);
  const cancelled = f.presenter.confirm(input()); f.presenter.cancel(); assert.equal(await cancelled, false);
});

test('consent cannot navigate away, open another window or attach a webview', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const pending = f.presenter.confirm(input()), view = f.views[0]; let prevented = 0;
  view.webContents.emit('will-navigate', { preventDefault: () => prevented++ });
  view.webContents.emit('will-attach-webview', { preventDefault: () => prevented++ });
  assert.equal(prevented, 2); assert.deepEqual(view.openHandler({ url: 'https://evil.example' }), { action: 'deny' });
  view.webContents.emit('render-process-gone'); assert.equal(await pending, false);
});

test('a new prompt releases the previous prompt and cannot reuse its reply channel', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const old = f.presenter.confirm(input()), first = f.views[0];
  const next = f.presenter.confirm(input()), second = f.views[1];
  assert.equal(await old, false); assert.notEqual(first.channels().decision, second.channels().decision);
  f.ipcMain.emit(first.channels().decision, first.event(), true); assert.equal(second.webContents.isDestroyed(), false);
  f.ipcMain.emit(second.channels().decision, second.event(), false); assert.equal(await next, false);
});

test('the child starts centered on its owner and does not resize or minimize independently', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const pending = f.presenter.confirm(input()), view = f.views[0];
  assert.equal(view.options.x + view.options.width / 2, f.window.bounds.x + f.window.bounds.width / 2);
  assert.equal(view.options.y + view.options.height / 2, f.window.bounds.y + f.window.bounds.height / 2);
  assert.equal(view.options.resizable, false); assert.equal(view.options.minimizable, false);
  f.presenter.cancel(); assert.equal(await pending, false); assert.equal(f.window.listenerCount('resize'), 0);
});

test('closing the host removes the pending card and its IPC handlers', async () => {
  const f = fixture(), pending = f.presenter.confirm(input());
  f.window.destroyed = true; f.window.emit('closed');
  assert.equal(await pending, false); assert.equal(f.views[0].webContents.isDestroyed(), true);
  assert.equal(f.handlers.size, 0); assert.equal(f.window.listenerCount('resize'), 0);
});

test('the initial and live themes follow the host and stop updating after the popup closes', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel()); f.presenter.setTheme('light');
  const pending = f.presenter.confirm(input()), view = f.views[0];
  assert.ok(view.options.webPreferences.additionalArguments.includes('--aily-hub-theme=light'));
  assert.equal(f.handlers.get(view.channels().data)(view.event()).theme, 'light');
  f.presenter.setTheme('dark');
  assert.equal(f.handlers.get(view.channels().data)(view.event()).theme, 'dark');
  assert.equal(view.webContents.messages.at(-1)[1], 'dark');
  const count = view.webContents.messages.length; f.presenter.setTheme('invalid');
  assert.equal(view.webContents.messages.length, count);
  f.presenter.cancel(); assert.equal(await pending, false); f.presenter.setTheme('light');
  assert.equal(view.webContents.messages.length, count);
});
