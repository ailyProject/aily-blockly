'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createWebviewDebuggerSurfaceManager,
  normalizeBounds,
} = require('./webview-debugger-surface');

class FakeGuestContents extends EventEmitter {
  constructor() {
    super();
    this.url = '';
    this.loading = false;
    this.destroyed = false;
    this.navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
    };
    this.session = {
      setPermissionCheckHandler: handler => { this.permissionCheckHandler = handler; },
      setPermissionRequestHandler: handler => { this.permissionRequestHandler = handler; },
    };
  }

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  getURL() { return this.url; }
  getTitle() { return this.url ? 'Fixture page' : ''; }
  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; }
  reload() {}
  stop() { this.loading = false; }
  openDevTools(options) { this.devtoolsOptions = options; }
  async loadURL(url) {
    this.url = url;
    this.loading = true;
    this.emit('did-start-loading');
    this.loading = false;
    this.emit('did-stop-loading');
  }
  async executeJavaScript(source) {
    if (source.includes('document.querySelector')) {
      return { url: this.url, title: 'Fixture page', text: 'ready', html: '<body>ready</body>' };
    }
    return { kind: 'number', value: 42 };
  }
}

function createFixture() {
  const handlers = new Map();
  const ownerContents = {
    id: 7,
    sent: [],
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    send(channel, payload) { this.sent.push({ channel, payload }); },
  };
  const ownerWindow = {
    destroyed: false,
    views: [],
    webContents: ownerContents,
    isDestroyed() { return this.destroyed; },
    getContentBounds() { return { width: 1000, height: 700 }; },
    contentView: {
      addChildView: view => ownerWindow.views.push(view),
      removeChildView: view => { ownerWindow.views = ownerWindow.views.filter(item => item !== view); },
    },
  };
  const views = [];
  class FakeWebContentsView {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeGuestContents();
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
    setBackgroundColor(color) { this.backgroundColor = color; }
    setVisible(visible) { this.visible = visible; }
  }
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const BrowserWindow = {
    fromWebContents: sender => sender === ownerContents ? ownerWindow : null,
  };
  const manager = createWebviewDebuggerSurfaceManager({
    BrowserWindow,
    WebContentsView: FakeWebContentsView,
    shell: { openExternal: async () => undefined },
  });
  manager.register(ipcMain);
  const event = { sender: ownerContents };
  const invoke = (channel, payload) => handlers.get(channel)(event, payload);
  return { invoke, ownerContents, ownerWindow, views };
}

test('normalizes native surface bounds inside the owner content area', () => {
  assert.deepEqual(normalizeBounds(
    { x: 980, y: -10, width: 500, height: 900 },
    { width: 1000, height: 700 },
  ), { x: 980, y: 0, width: 20, height: 700 });
});

test('creates a sandboxed dedicated guest and supports bounded commands', async () => {
  const fixture = createFixture();
  const created = await fixture.invoke('webview-debugger-surface-create', {
    url: 'about:blank',
    bounds: { x: 20, y: 30, width: 640, height: 480 },
    visible: true,
  });
  assert.equal(created.ok, true);
  const [view] = fixture.views;
  assert.deepEqual(view.bounds, { x: 20, y: 30, width: 640, height: 480 });
  assert.equal(view.visible, true);
  assert.equal(view.webContents.permissionCheckHandler(), false);
  let permissionAllowed = true;
  view.webContents.permissionRequestHandler(null, 'camera', allowed => { permissionAllowed = allowed; });
  assert.equal(permissionAllowed, false);
  assert.deepEqual(view.options.webPreferences, {
    allowRunningInsecureContent: false,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    partition: 'persist:aily-webview-debugger',
    sandbox: true,
    spellcheck: false,
    webSecurity: true,
  });

  const navigated = await fixture.invoke('webview-debugger-surface-command', {
    surfaceId: created.surfaceId,
    action: 'navigate',
    params: { url: 'https://example.com/' },
  });
  assert.equal(navigated.ok, true);
  assert.equal(navigated.page.url, 'https://example.com/');

  const snapshotted = await fixture.invoke('webview-debugger-surface-command', {
    surfaceId: created.surfaceId,
    action: 'snapshot',
    params: { selector: 'body' },
  });
  assert.equal(snapshotted.snapshot.text, 'ready');

  const resized = await fixture.invoke('webview-debugger-surface-bounds', {
    surfaceId: created.surfaceId,
    bounds: { x: 0, y: 0, width: 800, height: 500 },
    visible: false,
  });
  assert.equal(resized.ok, true);
  assert.equal(view.visible, false);
});

test('rejects credentialed or privileged URLs and enforces renderer ownership', async () => {
  const fixture = createFixture();
  const rejected = await fixture.invoke('webview-debugger-surface-create', {
    url: 'file:///tmp/private.txt',
    bounds: { width: 100, height: 100 },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorCode, 'WEBVIEW_NAVIGATION_REJECTED');

  const created = await fixture.invoke('webview-debugger-surface-create', {
    url: 'about:blank',
    bounds: { width: 100, height: 100 },
  });
  fixture.ownerContents.id = 8;
  const missing = await fixture.invoke('webview-debugger-surface-command', {
    surfaceId: created.surfaceId,
    action: 'state',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.errorCode, 'WEBVIEW_SURFACE_NOT_FOUND');
});
