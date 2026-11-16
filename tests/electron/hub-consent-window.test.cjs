const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHubConsentPresenter } = require('../../electron/hub-consent-window');

function fixture() {
  const views = [], handlers = new Map(), ipcMain = new EventEmitter(), window = new EventEmitter();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  ipcMain.removeHandler = name => handlers.delete(name);
  window.destroyed = false; window.bounds = { width: 1200, height: 780 };
  window.isDestroyed = () => window.destroyed; window.isMinimized = () => false;
  window.getContentBounds = () => window.bounds; window.show = () => {};
  window.focusRestored = 0; window.webContents = { focus: () => window.focusRestored++ };
  window.contentView = { children: [], addChildView(view) { this.children.push(view); },
    removeChildView(view) { this.children = this.children.filter(item => item !== view); } };
  class View {
    constructor(options) {
      this.options = options; this.visible = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.destroyed = false;
      this.webContents.isDestroyed = () => this.webContents.destroyed;
      this.webContents.close = () => { this.webContents.destroyed = true; this.webContents.emit('destroyed'); };
      this.webContents.focused = false;
      this.webContents.focus = () => { this.webContents.focused = true; };
      this.webContents.isFocused = () => this.webContents.focused;
      this.webContents.loadFile = async file => { this.file = file; };
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      views.push(this);
    }
    setVisible(value) { this.visible = value; }
    setBounds(bounds) { this.bounds = bounds; }
    setBackgroundColor(color) { this.background = color; }
    channels() {
      const id = this.options.webPreferences.additionalArguments[0].split('=')[1];
      return { data: `hub-consent:${id}:data`, decision: `hub-consent:${id}:decision` };
    }
    event() { return { sender: this.webContents, senderFrame: this.webContents.mainFrame }; }
  }
  const presenter = createHubConsentPresenter({ window, WebContentsView: View, ipcMain });
  return { presenter, window, views, handlers, ipcMain };
}
const input = () => ({ account: '测试账号 B · b@example.test', origin: 'https://hub.aily.pro', expiresAt: Date.now() + 120000 });

test('consent is attached inside its host and only its exact sandboxed frame can approve', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const pending = f.presenter.confirm(input()), view = f.views[0], channels = view.channels();
  assert.deepEqual(f.window.contentView.children, [view]); assert.equal(view.background, '#00000000');
  assert.equal(view.options.webPreferences.sandbox, true); assert.equal(view.options.webPreferences.nodeIntegration, false);
  assert.equal(view.options.webPreferences.contextIsolation, true); assert.equal(view.options.webPreferences.webSecurity, true);
  assert.equal(view.visible, false); view.webContents.emit('did-finish-load'); assert.equal(view.visible, true);
  assert.equal(f.handlers.get(channels.data)(view.event()).account, input().account);
  assert.equal(f.handlers.get(channels.data)({ sender: view.webContents, senderFrame: {} }), null);
  f.ipcMain.emit(channels.decision, { sender: view.webContents, senderFrame: {} }, true);
  assert.equal(view.webContents.isDestroyed(), false);
  f.ipcMain.emit(channels.decision, view.event(), true);
  assert.equal(await pending, true); assert.equal(view.webContents.isDestroyed(), true);
  assert.deepEqual(f.window.contentView.children, []);
  assert.equal(f.window.focusRestored, 1);
  assert.equal(f.handlers.size, 0); assert.equal(f.ipcMain.listenerCount(channels.decision), 0);
});

test('closing, timeout and explicit cancellation never approve', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const closing = f.presenter.confirm(input()); f.views[0].webContents.close(); assert.equal(await closing, false);
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

test('the popup remains within the main content bounds after resize', async t => {
  const f = fixture(); t.after(() => f.presenter.cancel());
  const pending = f.presenter.confirm(input()), view = f.views[0];
  for (const bounds of [{ width: 1200, height: 780 }, { width: 800, height: 600 }, { width: 520, height: 540 }]) {
    f.window.bounds = bounds; f.window.emit('resize');
    assert.ok(view.bounds.x >= 0 && view.bounds.y >= 40);
    assert.ok(view.bounds.x + view.bounds.width <= bounds.width);
    assert.ok(view.bounds.y + view.bounds.height <= bounds.height);
  }
  f.presenter.cancel(); assert.equal(await pending, false); assert.equal(f.window.listenerCount('resize'), 0);
});

test('closing the host removes the pending card and its IPC handlers', async () => {
  const f = fixture(), pending = f.presenter.confirm(input());
  f.window.destroyed = true; f.window.emit('closed');
  assert.equal(await pending, false); assert.equal(f.views[0].webContents.isDestroyed(), true);
  assert.equal(f.handlers.size, 0); assert.equal(f.window.listenerCount('resize'), 0);
});
