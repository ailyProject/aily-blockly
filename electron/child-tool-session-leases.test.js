const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  acquireOwner, authorizeExclusiveRestart, authorizeMessagePortSend,
  bindMessageController, clearMessageControllerBinding,
  electMessageControllerOwner, ownerCount, releaseOwner,
  releaseOwnerFromSessions, setMessageControllerOwner, unbindMessageController,
} = require('./child-tool-session-leases');

test('restart is restricted to the sole owner of the exact Runtime stream', () => {
  const session = { streamId: 'stream-v1', owners: new Map() };
  assert.equal(acquireOwner(session, 101, 'window-a').success, true);
  assert.deepEqual(authorizeExclusiveRestart(session, 101, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }), { success: true });
  assert.equal(authorizeExclusiveRestart(session, 102, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }).reason, 'shared-runtime-in-use');
  assert.equal(authorizeExclusiveRestart(session, 101, {
    streamId: 'old-stream', leaseId: 'window-a'
  }).reason, 'stale-session');

  acquireOwner(session, 102, 'window-b');
  assert.equal(authorizeExclusiveRestart(session, 101, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }).reason, 'shared-runtime-in-use');
  releaseOwner(session, 102, 'window-b');
  assert.equal(authorizeExclusiveRestart(session, 101, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }).success, true);
});

function controllerSession() {
  const session = {
    streamId: 'stream-v1', owners: new Map(),
    messagePort: { transport: 'node-ipc-v1', maxMessageBytes: 1024 },
  };
  acquireOwner(session, 102, 'standalone-ui');
  return session;
}

const binding = { streamId: 'stream-v1', bindingId: 'workspace-v1' };

test('workspace controller is exclusive without becoming a Runtime consumer', () => {
  const session = controllerSession();
  assert.equal(bindMessageController(session, 101, binding, 101).success, true);
  assert.equal(ownerCount(session), 1);
  assert.equal(electMessageControllerOwner(session), 101);
  assert.equal(setMessageControllerOwner(session, 101), true);
  assert.equal(setMessageControllerOwner(session, 102), false);
  assert.equal(authorizeMessagePortSend(session, 101, binding).success, true);
  assert.equal(authorizeMessagePortSend(session, 102, {
    streamId: session.streamId, leaseId: 'standalone-ui',
  }).reason, 'message-controller-not-authorized');
  assert.equal(authorizeMessagePortSend(session, 102, binding).reason, 'message-controller-not-authorized');
  assert.equal(authorizeExclusiveRestart(session, 102, {
    streamId: session.streamId, leaseId: 'standalone-ui',
  }).success, true);
  releaseOwner(session, 102, 'standalone-ui');
  assert.equal(ownerCount(session), 0);
  assert.equal(electMessageControllerOwner(session), 101);
  assert.equal(authorizeMessagePortSend(session, 101, binding).success, true);
});

test('controller bindings reject non-main owners, stale streams and stale binding tokens', () => {
  const session = controllerSession();
  assert.equal(bindMessageController(session, 102, binding, 101).reason, 'message-controller-not-authorized');
  assert.equal(bindMessageController(session, 101, { ...binding, streamId: 'old-stream' }, 101).reason, 'stale-session');
  assert.equal(bindMessageController(session, 101, { ...binding, bindingId: '' }, 101).reason, 'invalid-binding');
  bindMessageController(session, 101, binding, 101);
  const replacement = { ...binding, bindingId: 'workspace-v2' };
  bindMessageController(session, 101, replacement, 101);
  assert.equal(authorizeMessagePortSend(session, 101, binding).reason, 'message-controller-not-authorized');
  assert.equal(unbindMessageController(session, 101, binding, 101).reason, 'stale-binding');
  assert.equal(unbindMessageController(session, 101, { ...replacement, streamId: 'old-stream' }, 101).reason, 'stale-session');
  assert.equal(unbindMessageController(session, 102, replacement, 101).reason, 'message-controller-not-authorized');
  assert.equal(authorizeMessagePortSend(session, 101, { ...replacement, streamId: 'old-stream' }).reason, 'stale-session');
  assert.equal(unbindMessageController(session, 101, replacement, 101).success, true);
  assert.equal(authorizeMessagePortSend(session, 101, replacement).reason, 'message-controller-not-authorized');
  assert.equal(electMessageControllerOwner(session), 102);
  assert.equal(authorizeMessagePortSend(session, 102, {
    streamId: session.streamId, leaseId: 'standalone-ui',
  }).success, true);
});

test('controller binding is unavailable for stopped Runtime and cleanup is owner-specific', () => {
  const session = controllerSession();
  bindMessageController(session, 101, binding, 101);
  assert.equal(clearMessageControllerBinding(session, 102), false);
  assert.equal(clearMessageControllerBinding(session, 101), true);
  session.exit = { code: 0 };
  assert.equal(bindMessageController(session, 101, binding, 101).reason, 'message-port-unavailable');
  assert.equal(authorizeMessagePortSend(session, 102, {
    streamId: session.streamId, leaseId: 'standalone-ui',
  }).reason, 'message-port-unavailable');
  assert.equal(bindMessageController(null, 101, binding, 101).reason, 'message-port-unavailable');
});

// Execute the production registration/routing slices with only Electron edges mocked.
const windowSource = fs.readFileSync(path.join(__dirname, 'window.js'), 'utf8');
function windowSlice(start, end) {
  const from = windowSource.indexOf(start);
  const to = windowSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return windowSource.slice(from, to);
}

test('Electron controller IPC accepts only main renderer and replays the latest negotiation', () => {
  const session = controllerSession();
  session.lastProviderNegotiationRequest = {
    type: 'aily-subapp-host-provider.negotiation.request', request: { requestId: 'negotiate-1' },
  };
  const handlers = new Map();
  const main = { id: 101 };
  const tracked = [];
  vm.runInNewContext(windowSlice(
    '    ipcMain.handle("child-tool-session-controller-bind"',
    '    ipcMain.handle("child-tool-session-release"',
  ), {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    mainWindow: { webContents: main }, childToolSessions: new Map([['fixture', session]]),
    sanitizeChildToolId: value => String(value || '').trim(),
    bindChildToolMessageController: bindMessageController,
    unbindChildToolMessageController: unbindMessageController,
    trackChildToolSessionOwner: sender => tracked.push(sender.id),
  });
  const bind = handlers.get('child-tool-session-controller-bind');
  const unbind = handlers.get('child-tool-session-controller-unbind');
  const payload = { toolId: 'fixture', ...binding };
  assert.equal(bind({ sender: { id: 101 } }, payload).reason, 'message-controller-not-authorized');
  assert.equal(bind({ sender: { id: 102 } }, payload).reason, 'message-controller-not-authorized');
  const result = bind({ sender: main }, payload);
  assert.equal(result.success, true);
  assert.equal(result.negotiationRequest.request.requestId, 'negotiate-1');
  assert.equal(ownerCount(session), 1);
  assert.deepEqual(tracked, [101]);
  assert.equal(unbind({ sender: { id: 102 } }, payload).reason, 'message-controller-not-authorized');
  assert.equal(unbind({ sender: main }, payload).success, true);
  assert.equal(bind({ sender: main }, { ...payload, toolId: 'missing' }).reason, 'message-port-unavailable');
});

test('process routing prefers a non-consumer controller, caches one bounded record and falls back after death', () => {
  const session = controllerSession();
  bindMessageController(session, 101, binding, 101);
  const sent = [];
  let mainDead = false;
  const context = {
    Map, Set,
    webContents: { fromId: ownerId => ({
      isDestroyed: () => ownerId === 101 && mainDead,
      send: (channel, payload) => sent.push({ ownerId, channel, payload }),
    }) },
    normalizeProcessMessage: require('./child-process-message-port').normalizeProcessMessage,
    electChildToolMessageControllerOwner: electMessageControllerOwner,
    setChildToolMessageControllerOwner: setMessageControllerOwner,
    clearChildToolMessageControllerBinding: clearMessageControllerBinding,
    console: { warn() {} },
  };
  vm.runInNewContext(windowSlice('function deliverChildToolProcessMessage(', 'function routeChildToolProcessMessage('), context);
  const request = requestId => ({
    type: 'aily-subapp-host-provider.negotiation.request', request: { requestId },
  });
  assert.equal(context.deliverChildToolProcessMessage('fixture', session, request('first')), 1);
  context.deliverChildToolProcessMessage('fixture', session, request('latest'));
  assert.equal(session.lastProviderNegotiationRequest.request.requestId, 'latest');
  assert.deepEqual(sent.map(entry => entry.ownerId), [101, 101]);
  context.deliverChildToolProcessMessage('fixture', session, { type: 'other-message' });
  assert.equal(session.lastProviderNegotiationRequest.request.requestId, 'latest');
  context.deliverChildToolProcessMessage('fixture', session, { ...request('oversized'), extra: 'x'.repeat(2048) });
  assert.equal(session.lastProviderNegotiationRequest, undefined);
  mainDead = true;
  context.deliverChildToolProcessMessage('fixture', session, { type: 'fallback' });
  assert.equal(sent.at(-1).ownerId, 102);
  assert.equal(session.providerMessageController, undefined);
  assert.equal(authorizeMessagePortSend(session, 101, binding).reason, 'message-controller-not-authorized');
});

test('renderer cleanup revokes a controller even when it holds no consumer lease', () => {
  const session = controllerSession();
  bindMessageController(session, 101, binding, 101);
  let broadcasts = 0;
  const context = {
    childToolSessions: new Map([['fixture', session]]),
    clearChildToolMessageControllerBinding: clearMessageControllerBinding,
    releaseChildToolOwnerFromSessions: releaseOwnerFromSessions,
    childToolOwnerCount: ownerCount,
    scheduleChildToolRelease() { throw new Error('A live UI lease must be retained'); },
    broadcastChildToolSessionStateChanged() { broadcasts += 1; },
    console: { info() {} },
  };
  vm.runInNewContext(windowSlice('function releaseChildToolSessionsForOwner(', 'function trackChildToolSessionOwner('), context);
  context.releaseChildToolSessionsForOwner(101);
  assert.equal(session.providerMessageController, undefined);
  assert.equal(ownerCount(session), 1);
  assert.equal(broadcasts, 1);
});

test('Runtime exit clears its controller binding and cached negotiation', () => {
  const session = controllerSession();
  bindMessageController(session, 101, binding, 101);
  session.lastProviderNegotiationRequest = { type: 'fixture-negotiation' };
  const context = {
    browserExecutionHost: { closeRuntime: async () => {} },
    childToolSessions: new Map([['fixture', session]]),
    pendingChildToolProcessMessages: new Map(), ailyHostAuthRelay: null,
    applicationIsQuitting: false,
    clearChildToolMessageControllerBinding: clearMessageControllerBinding,
    cancelChildToolRelease() {}, broadcastChildToolSessionStateChanged() {},
    console: { info() {} },
  };
  vm.runInNewContext(windowSlice('function handleChildToolProcessExit(', 'function scheduleChildToolRelease('), context);
  context.handleChildToolProcessExit({ streamId: session.streamId, code: 0, signal: null, expected: true });
  assert.equal(session.providerMessageController, undefined);
  assert.equal(session.lastProviderNegotiationRequest, undefined);
  assert.equal(authorizeMessagePortSend(session, 101, binding).reason, 'message-port-unavailable');
});

test('final consumer release still schedules and stops the Runtime while controller remains bound', async () => {
  const session = controllerSession();
  session.hostInfo = { persistent: false };
  session.releaseTimer = null;
  bindMessageController(session, 101, binding, 101);
  releaseOwner(session, 102, 'standalone-ui');
  let release;
  let stopped = 0;
  const sessions = new Map([['fixture', session]]);
  const context = {
    childToolSessions: sessions, childToolOwnerCount: ownerCount,
    CHILD_TOOL_RELEASE_GRACE_MS: 15000,
    pendingChildToolProcessMessages: new Map(),
    setTimeout(callback) { release = callback; return { timer: true }; },
    stopChildToolSessionProcess: async input => { assert.equal(input, session); stopped += 1; return true; },
    broadcastChildToolSessionStateChanged() {}, console: { info() {}, warn() {} },
  };
  vm.runInNewContext(windowSlice('function scheduleChildToolRelease(', 'function releaseChildToolSession('), context);
  context.scheduleChildToolRelease('fixture', session);
  assert.equal(typeof release, 'function');
  assert.equal(session.providerMessageController.ownerId, 101);
  release();
  await Promise.resolve();
  assert.equal(stopped, 1);
  assert.equal(sessions.has('fixture'), false);
});
