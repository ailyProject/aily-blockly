const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseHubBrowserLogin, createHubBrowserBridge, forwardHubBrowserLogin, hasHubBrowserOwner, deliverHubBrowserResult, reportHubBrowserOpened } = require('../../electron/hub-browser-login');
const makeUrl = (state = 's'.repeat(43), callback = 'https://hub.aily.pro/auth/callback', product = 'abis') =>
  `${product}://auth/hub/login?` + new URLSearchParams({ state, code_challenge: 'c'.repeat(43), redirect_uri: callback });

function fixture(directory, response = 1, deliverResult, browserReturn = { capture() {}, restore() {}, close() {} }) {
  const window = new EventEmitter(), contents = new EventEmitter(), handlers = new Map(), messages = [], dialogs = [], themes = [];
  contents.mainFrame = {}; contents.send = (...args) => messages.push(args);
  Object.assign(window, { webContents: contents, isDestroyed: () => false, show() { throw new Error('Main window must not be raised'); }, focus() { throw new Error('Main window must not be focused'); } });
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const consentPresenter = { confirm: async options => { dialogs.push(options); return response === 1; }, cancel() {}, setTheme: theme => themes.push(theme) };
  const bridge = createHubBrowserBridge({ window, ipcMain, consentPresenter, browserReturn, product: 'blockly', development: true, directory, deliverResult });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { bridge, messages, dialogs, themes, window, call: (name, input, e = event) => handlers.get(name)(e, input),
    deliver: (state, callbackUrl, e = event) => handlers.get('hub-client-deliver')(e, state, callbackUrl) };
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

test('site and registered authorization callback cannot be replaced with unknown protocol fields', () => {
  const link = makeUrl() + '&region=intl&authorization_redirect_uri=' + encodeURIComponent('https://hub.aily.pro/auth/callback');
  assert.equal(parseHubBrowserLogin(link, 'blockly').region, 'intl');
  for (const invalid of [link + '&region=cn', link.replace('region=intl', 'region=other'),
    link.replace('hub.aily.pro%2Fauth', 'evil.example%2Fauth'), link + '&extra=value']) {
    assert.throws(() => parseHubBrowserLogin(invalid, 'blockly'));
  }
});

test('browser receipts require a complete secret and trusted endpoint pair', () => {
  const endpoint = 'https://hubapi.aily.pro/api/v1/hub/auth/desktop/browser/result';
  const link = makeUrl() + '&' + new URLSearchParams({ receipt_uri: endpoint, receipt_token: 'r'.repeat(43) });
  assert.equal(parseHubBrowserLogin(link, 'blockly').receipt_uri, endpoint);
  for (const invalid of [link.replace('hubapi.aily.pro', 'evil.example'), link.replace('%2Fbrowser%2Fresult', '%2Fother'),
    link.replace('&receipt_token=', '&other='), link.replace('r'.repeat(43), 'short')]) {
    assert.throws(() => parseHubBrowserLogin(invalid, 'blockly'));
  }
});

test('browser receipt delivery waits for acknowledgment and preserves closed-tab fallback', async () => {
  const request = { state: 's'.repeat(43), redirect_uri: 'https://hub.aily.pro/auth/callback',
    receipt_uri: 'https://hubapi.aily.pro/api/v1/hub/auth/desktop/browser/result', receipt_token: 'r'.repeat(43), expiresAt: Date.now() + 10000 };
  const callback = 'https://hub.aily.pro/auth/desktop?state=' + request.state + '&error=access_denied';
  const deliveries = ['waiting', 'tab']; let calls = 0;
  const fetcher = async (url, options) => {
    assert.equal(url, request.receipt_uri); assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).receiptToken, request.receipt_token); calls++;
    return Response.json({ status: 200, data: { delivery: deliveries.shift() } });
  };
  assert.equal(await deliverHubBrowserResult(request, callback, fetcher), true); assert.equal(calls, 2);
  assert.equal(await deliverHubBrowserResult(request, callback, async () => Response.json({ status: 200, data: { delivery: 'fallback' } })), false);
  assert.equal(await deliverHubBrowserResult(request, callback, async () => Response.json({ status: 200, data: { delivery: 'cancelled' } })), 'cancelled');
  let unavailable = 0;
  assert.equal(await deliverHubBrowserResult(request, callback, async () => { unavailable++; throw new Error('Network unavailable'); }), true);
  assert.equal(unavailable, 3, 'uncertain network delivery must not open a duplicate callback tab');
  assert.equal(await deliverHubBrowserResult(request, callback.replace('hub.aily.pro', 'evil.example'), fetcher), false);
});

test('opening status posts only to the validated receipt sibling with the current flow secret', async () => {
  const state = 's'.repeat(43), receiptToken = 'r'.repeat(43), endpoint = 'https://hubapi.aily.pro/api/v1/hub/auth/desktop/browser/';
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, redirect: options.redirect, body: JSON.parse(options.body) });
    return Response.json({}, { status: 404 }); // Older services can still receive the final result.
  };
  await reportHubBrowserOpened({ state, receipt_uri: endpoint + 'result', receipt_token: receiptToken, expiresAt: Date.now() + 1000 }, fetcher);
  await reportHubBrowserOpened({ state, receipt_uri: endpoint + 'result', receipt_token: receiptToken, expiresAt: 0 }, fetcher);
  assert.deepEqual(calls, [{ url: endpoint + 'opened', redirect: 'error', body: { state, receiptToken } }]);
});

test('only the active host frame can deliver its current login result', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-')); let delivered = 0;
  const f = fixture(directory, 1, async () => { delivered++; return true; });
  t.after(() => { f.bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await f.bridge.ready; f.bridge.accept(makeUrl());
  const state = 's'.repeat(43), callback = 'https://hub.aily.pro/auth/desktop?state=' + state + '&error=access_denied';
  assert.equal(await f.deliver(state, callback, { sender: f.window.webContents, senderFrame: {} }), false);
  assert.equal(await f.deliver('x'.repeat(43), callback), false); assert.equal(delivered, 0);
  assert.equal(await f.deliver(state, callback), true); assert.equal(delivered, 1);
});

for (const outcome of ['access_denied', 'success']) {
  test(`a ${outcome} result returns focus to the captured browser after receipt delivery`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-'));
    const target = {}, events = [];
    const f = fixture(directory, outcome === 'success' ? 1 : 0, async () => { events.push('delivered'); return true; }, {
      capture() { events.push('capture'); return target; },
      restore(value) { assert.equal(value, target); events.push('restore'); },
      close() { events.push('close'); },
    });
    t.after(() => { f.bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    await f.bridge.ready; f.bridge.accept(makeUrl()); f.call('hub-client-ready');
    assert.equal(Object.values(f.messages[0][1]).includes(target), false, 'native target must not reach renderer IPC');
    await f.call('hub-client-confirm', { state: 's'.repeat(43), account: 'Fixture' });
    assert.equal(await f.deliver('s'.repeat(43), 'https://hub.aily.pro/auth/desktop?state=' + 's'.repeat(43) + '&error=' + outcome), true);
    assert.deepEqual(events, ['capture', 'delivered', 'restore']);
  });
}

test('fallback, interrupted flows and activation failure do not change receipt decisions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-'));
  let delivery = false, restored = 0, settle, capture = () => ({});
  const f = fixture(directory, 1, () => delivery, {
    capture: () => capture(), restore() { restored++; throw new Error('Browser exited'); }, close() {},
  });
  t.after(() => { f.bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await f.bridge.ready; f.bridge.accept(makeUrl());
  const state = 's'.repeat(43), callback = 'https://hub.aily.pro/auth/desktop?state=' + state;
  assert.equal(await f.deliver(state, callback), false); assert.equal(restored, 0);
  delivery = 'cancelled';
  assert.equal(await f.deliver(state, callback), true, 'prevent the renderer from opening a cancelled result');
  assert.equal(restored, 0, 'do not refocus the original browser for a cancelled web flow');
  delivery = true;
  assert.equal(await f.deliver(state, callback), true); assert.equal(restored, 1);
  delivery = new Promise(resolve => { settle = resolve; });
  const pending = f.deliver(state, callback); f.call('hub-client-finish', state); settle(true);
  assert.equal(await pending, true); assert.equal(restored, 1, 'a discarded flow must not steal focus');
  let captureReady;
  capture = () => new Promise(resolve => { captureReady = resolve; }); delivery = true;
  const nextState = 't'.repeat(43); f.bridge.accept(makeUrl(nextState));
  const waitingForCapture = f.deliver(nextState, callback.replace(state, nextState));
  await Promise.resolve(); f.call('hub-client-finish', nextState); captureReady({});
  assert.equal(await waitingForCapture, true); assert.equal(restored, 1, 'discarding during capture must not restore focus');
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

test('receipt handoffs skip legacy owners and cold-start detection requires a compatible owner', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-'));
  const current = fixture(directory); await current.bridge.ready;
  const currentFiles = new Set(fs.readdirSync(directory));
  const legacy = fixture(directory); await legacy.bridge.ready;
  t.after(() => { current.bridge.close(); legacy.bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  current.call('hub-client-ready'); legacy.call('hub-client-ready');
  const filename = path.join(directory, fs.readdirSync(directory).find(name => !currentFiles.has(name)));
  const record = JSON.parse(fs.readFileSync(filename, 'utf8')); delete record.protocolVersion; record.focusedAt = Date.now() + 1000;
  fs.writeFileSync(filename, JSON.stringify(record));
  const link = makeUrl() + '&' + new URLSearchParams({ receipt_uri: 'https://hubapi.aily.pro/api/v1/hub/auth/desktop/browser/result', receipt_token: 'r'.repeat(43) });
  await forwardHubBrowserLogin(link, 'blockly', { directory, development: true });
  assert.equal(current.messages.length, 1); assert.equal(legacy.messages.length, 0);
  current.bridge.close();
  assert.equal(hasHubBrowserOwner('blockly', { directory }), true);
  assert.equal(hasHubBrowserOwner('blockly', { directory, receipts: true }), false);
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
