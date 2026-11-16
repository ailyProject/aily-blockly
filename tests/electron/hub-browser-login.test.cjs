const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseHubBrowserLogin, createHubBrowserBridge, forwardHubBrowserLogin, hasHubBrowserOwner } = require('../../electron/hub-browser-login');
const makeUrl = (state = 's'.repeat(43), callback = 'https://hub.aily.pro/auth/callback', product = 'abis') =>
  `${product}://auth/hub/login?` + new URLSearchParams({ state, code_challenge: 'c'.repeat(43), redirect_uri: callback });

function fixture(directory, response = 1) {
  const window = new EventEmitter(), contents = new EventEmitter(), handlers = new Map(), messages = [], dialogs = [], themes = [];
  contents.mainFrame = {}; contents.send = (...args) => messages.push(args);
  Object.assign(window, { webContents: contents, isDestroyed: () => false, show() { throw new Error('Main window must not be raised'); }, focus() { throw new Error('Main window must not be focused'); } });
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const consentPresenter = { confirm: async options => { dialogs.push(options); return response === 1; }, cancel() {}, setTheme: theme => themes.push(theme) };
  const bridge = createHubBrowserBridge({ window, ipcMain, consentPresenter, product: 'blockly', development: true, directory });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { bridge, messages, dialogs, themes, window, call: (name, input, e = event) => handlers.get(name)(e, input) };
}

test('client protocol accepts only fixed products, PKCE and trusted callbacks', () => {
  assert.equal(parseHubBrowserLogin(makeUrl(), 'blockly').state, 's'.repeat(43));
  assert.ok(parseHubBrowserLogin(makeUrl(undefined, 'http://localhost:65469/auth/callback'), 'blockly', true));
  for (const value of [makeUrl() + '&state=' + 'x'.repeat(43), makeUrl() + '#fragment', makeUrl().replace('abis://auth', 'abis://user@auth'),
    makeUrl(undefined, 'https://evil.example/auth/callback'), makeUrl(undefined, 'https://hub.aily.pro/other'),
    makeUrl(undefined, 'https://hub.aily.pro/auth/callback?next=evil'), makeUrl('short')]) {
    assert.throws(() => parseHubBrowserLogin(value, 'blockly', true));
  }
  assert.throws(() => parseHubBrowserLogin(makeUrl(), 'coder'));
  assert.throws(() => parseHubBrowserLogin(makeUrl(undefined, 'http://localhost:65469/auth/callback'), 'blockly'));
});

test('a cold request waits for its renderer and requires an explicit native confirmation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-')), f = fixture(directory);
  t.after(() => { f.bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await f.bridge.ready;
  assert.equal(f.bridge.accept(makeUrl()), true); assert.deepEqual(f.messages, []); assert.deepEqual(f.dialogs, []);
  f.window.webContents.emit('did-start-navigation', {}, 'file:///renderer/index.html', false, true);
  assert.equal(f.call('hub-client-ready'), true);
  assert.equal(f.messages[0][0], 'hub-client-authorize');
  assert.equal(await f.call('hub-client-confirm', { state: 's'.repeat(43), account: '当前账号 B · b@example.test' }), true);
  assert.match(f.dialogs[0].account, /当前账号 B/); assert.equal(f.dialogs[0].origin, 'https://hub.aily.pro');
  assert.ok(f.dialogs[0].expiresAt > Date.now());
  assert.equal(f.call('hub-client-finish', 's'.repeat(43)), true);
  assert.equal(f.bridge.accept(makeUrl()), false);
});

test('cancelling never authorizes, and child frames cannot confirm another request', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-')), f = fixture(directory, 0);
  t.after(() => { f.bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await f.bridge.ready; f.bridge.accept(makeUrl()); f.call('hub-client-ready');
  const input = { state: 's'.repeat(43), account: 'Account B' };
  assert.equal(await f.call('hub-client-confirm', input, { sender: f.window.webContents, senderFrame: {} }), false);
  assert.equal(f.dialogs.length, 0);
  assert.equal(await f.call('hub-client-confirm', { ...input, state: 'x'.repeat(43) }), false);
  assert.equal(await f.call('hub-client-confirm', input), false);
  assert.equal(f.dialogs.length, 1);
});

test('the local relay delivers to the most recently focused running client', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-'));
  const a = fixture(directory), b = fixture(directory);
  t.after(() => { a.bridge.close(); b.bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await Promise.all([a.bridge.ready, b.bridge.ready]); a.call('hub-client-ready'); b.call('hub-client-ready');
  await new Promise(resolve => setTimeout(resolve, 5)); a.window.emit('focus');
  assert.equal(hasHubBrowserOwner('blockly', { directory }), true);
  await forwardHubBrowserLogin(makeUrl(), 'blockly', { directory, development: true });
  assert.equal(a.messages.length, 1); assert.equal(b.messages.length, 0);
  await assert.rejects(forwardHubBrowserLogin(makeUrl('x'.repeat(43)), 'blockly', { directory, development: true }));
  assert.equal(b.messages.length, 0, 'a busy focused client must not switch to another client account');
  assert.equal(hasHubBrowserOwner('coder', { directory }), false);
});

test('closing a destroyed window releases IPC and the owner record without accessing its native properties', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-')), f = fixture(directory);
  t.after(() => { f.bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await f.bridge.ready;
  Object.defineProperty(f.window, 'webContents', { get() { throw new Error('Object has been destroyed'); } });
  assert.doesNotThrow(() => f.bridge.close());
  assert.equal(hasHubBrowserOwner('blockly', { directory }), false);
});

test('Angular hash navigation preserves the ready renderer and its active consent request', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-')), f = fixture(directory);
  t.after(() => { f.bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await f.bridge.ready; f.call('hub-client-ready');
  f.window.webContents.emit('did-start-navigation', {}, 'http://localhost:4202/#/main', true, true);
  assert.equal(f.bridge.accept(makeUrl()), true);
  assert.equal(f.messages.length, 1, 'the already initialized Angular service still receives the login request');
  f.window.webContents.emit('did-start-navigation', {}, 'http://localhost:4202/#/main/settings', true, true);
  assert.equal(await f.call('hub-client-confirm', { state: 's'.repeat(43), account: 'Account B' }), true);
});

test('a full document navigation invalidates an active request until the new renderer initializes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-')), f = fixture(directory);
  t.after(() => { f.bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await f.bridge.ready; f.call('hub-client-ready'); f.bridge.accept(makeUrl());
  f.window.webContents.emit('did-start-navigation', {}, 'http://localhost:4202/', false, true);
  assert.equal(await f.call('hub-client-confirm', { state: 's'.repeat(43), account: 'Account B' }), false);
  assert.equal(f.bridge.accept(makeUrl('x'.repeat(43))), true); assert.equal(f.messages.length, 1);
  f.call('hub-client-ready'); assert.equal(f.messages.length, 2);
});

test('only the host main frame can synchronize a supported application theme', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-')), f = fixture(directory);
  t.after(() => { f.bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await f.bridge.ready;
  assert.equal(f.call('hub-client-theme', 'light', { sender: f.window.webContents, senderFrame: {} }), false);
  assert.equal(f.call('hub-client-theme', 'invalid'), false); assert.deepEqual(f.themes, []);
  assert.equal(f.call('hub-client-theme', 'light'), true); assert.deepEqual(f.themes, ['light']);
});
