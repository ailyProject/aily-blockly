'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const ts = require('typescript');
const { WebSocketServer } = require('ws');
const { createApplicationQuitCoordinator } = require('./application-quit');
const { SubappOwnerSupervisor } = require('./subapp-owner-supervisor');
const { sendLifecycleRequest } = require('./subapp-lifecycle-rpc');

function source(file) {
  return ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, file), 'utf8'), ts.ScriptTarget.Latest, true);
}
function select(root, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root);
  assert.equal(found.length, 1);
  return found[0].getText(root);
}
const main = source('main.js');
const cleanup = select(main, node => ts.isFunctionDeclaration(node) && node.name?.text === 'cleanupRegisteredChildProcesses');
const quitSetup = select(main, node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => declaration.name.getText(main) === 'applicationQuit'));
const settle = () => new Promise(resolve => setImmediate(resolve));

function host(overrides = {}) {
  const app = new EventEmitter();
  const calls = [];
  const warnings = [];
  const quitRequested = Promise.withResolvers();
  let quits = 0;
  app.quit = () => { quits++; quitRequested.resolve(); };
  const sandbox = vm.createContext({
    app, console: { info() {}, warn: (...args) => warnings.push(args) },
    ipcMain: new EventEmitter(), mainWindow: null, createApplicationQuitCoordinator,
    isCurrentRendererGenerationReady: () => false,
    beginWindowShutdown: options => { assert.equal(options.notifyRenderers, false); calls.push('fence-windows'); },
    notifyWindowShutdown: () => calls.push('notify-windows'), cliBridge: { close: () => calls.push('stop-cli') },
    beginCommandShutdown: () => calls.push('block-commands'),
    beginNpmShutdown: () => calls.push('block-npm'),
    beginAuthCredentialsShutdown: () => calls.push('block-auth'),
    releaseAllAuthCredentialsLocks: () => calls.push('release-auth'),
    shutdownSubappOwners: async () => { calls.push('stop-subapp-owners'); return { ok: true, remainingBindings: 0 }; },
    stopAllChildToolSessions: async () => { calls.push('stop-child-tools'); },
    getActiveCmdProcesses: () => [], getActiveNpmProcesses: () => [],
    getActiveTerminals: () => [], getActiveAilyServicesStreams: () => [],
    killAllCmdProcesses: async () => { calls.push('stop-commands'); return true; },
    killAllNpmProcesses: async () => { calls.push('stop-npm'); return true; },
    killAllTerminals: async () => {}, cancelAllAilyServicesStreams: async () => {},
    connector: { shutdown: async () => {} }, simulatorGateway: { stop: async () => {} },
    simulatorSubappHost: { defaultHost: { stop: async () => {} } },
    packagedRendererServer: { close: async () => {} },
    ...overrides,
  });
  vm.runInContext(cleanup + '\n' + quitSetup, sandbox);
  return { calls, warnings, whenQuit: quitRequested.promise, get quits() { return quits; },
    get completed() { return vm.runInContext('applicationQuit.canClose()', sandbox); },
    begin() { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); return prevented; },
  };
}

test('quit blocks new commands and installers before stopping registered processes', async () => {
  const h = host();
  assert.equal(h.begin(), true);
  await settle();
  assert.deepEqual(h.calls, ['fence-windows', 'stop-cli', 'block-commands', 'block-npm', 'block-auth',
    'stop-subapp-owners', 'notify-windows', 'stop-child-tools', 'stop-commands', 'stop-npm', 'release-auth']);
  assert.equal(h.completed, true);
  assert.equal(h.quits, 1);
  assert.equal(h.begin(), false);
});

test('quit keeps the original Renderer providers alive until their held owner finalizer acknowledges', async () => {
  const entered = Promise.withResolvers(), ack = Promise.withResolvers();
  let providerAlive = true;
  const h = host({
    notifyWindowShutdown: () => { providerAlive = false; },
    shutdownSubappOwners: async () => {
      assert.equal(providerAlive, true); entered.resolve(); await ack.promise;
      assert.equal(providerAlive, true); return { ok: true, remainingBindings: 0 };
    },
    stopAllChildToolSessions: async () => { assert.equal(providerAlive, false); },
  });
  h.begin(); await entered.promise;
  assert.equal(h.quits, 0); assert.equal(providerAlive, true);
  assert.deepEqual(h.calls, ['fence-windows', 'stop-cli', 'block-commands', 'block-npm', 'block-auth']);
  ack.resolve(); await settle(); assert.equal(providerAlive, false); assert.equal(h.quits, 1);
});

test('window shutdown fences allocation immediately and notifies existing renderers once in its separate drain phase', () => {
  const windowSource = source('window.js'), sent = [];
  const declarations = ['applicationIsQuitting', 'rendererShutdownNotified'].map(name => select(windowSource,
    node => ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(windowSource) === name)));
  const functions = ['beginWindowShutdown', 'notifyWindowShutdown'].map(name => select(windowSource,
    node => ts.isFunctionDeclaration(node) && node.name?.text === name));
  const context = vm.createContext({ console: { warn() {} }, BrowserWindow: { getAllWindows: () => [{
    isDestroyed: () => false, webContents: { isDestroyed: () => false, send: name => sent.push(name) },
  }] } });
  vm.runInContext([...declarations, ...functions].join('\n'), context);
  vm.runInContext('beginWindowShutdown({notifyRenderers:false})', context);
  assert.equal(vm.runInContext('applicationIsQuitting', context), true); assert.deepEqual(sent, []);
  vm.runInContext('notifyWindowShutdown(); beginWindowShutdown(); notifyWindowShutdown()', context);
  assert.deepEqual(sent, ['child-tool-host-shutdown']);
});

test('duplicate quit shares cleanup and waits for registered process cleanup', async () => {
  let finish, stops = 0;
  const h = host({ killAllCmdProcesses: () => { stops++; return new Promise(resolve => { finish = resolve; }); } });
  h.begin(); h.begin(); await settle();
  assert.equal(stops, 1);
  assert.equal(h.quits, 0);
  finish(true); await settle();
  assert.equal(h.quits, 1);
});

test('one failing cleanup still allows the remaining services to finish before quit', async () => {
  let finish;
  const h = host({
    killAllCmdProcesses: async () => { throw new Error('fixture stop failure'); },
    killAllNpmProcesses: () => new Promise(resolve => { finish = resolve; }),
  });
  h.begin(); await settle();
  assert.equal(h.quits, 0);
  finish(true); await settle();
  assert.equal(h.completed, true);
  assert.equal(h.quits, 1);
});

async function lifecycleEndpoint(t, receive) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let closing;
  const close = () => closing ||= new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    for (const client of server.clients) client.terminate();
  });
  t.after(close);
  server.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(String(raw));
    receive(request, reply => socket.send(JSON.stringify({ id: request.id, ...reply })));
  }));
  await once(server, 'listening');
  return { close, get listening() { return server.address() !== null; }, runtime: {
    streamId: 'shutdown-fixture-runtime', hostInfo: {
      wsUrl: `ws://127.0.0.1:${server.address().port}/ws`,
      runtimeConfig: { agent: { lifecycle: {
        ownerRelease: { method: 'fixture.owner.release', timeoutMs: 5000 },
      } } },
    },
  } };
}

function renderer(id = 1) {
  return Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
}

test('Main waits for a real ownerRelease ACK before closing its Runtime and starting process fallback', { timeout: 10000 }, async t => {
  const releaseReceived = Promise.withResolvers();
  const order = [];
  let acknowledge, acknowledged = false;
  const endpoint = await lifecycleEndpoint(t, (request, reply) => {
    assert.equal(request.method, 'fixture.owner.release');
    assert.equal(request.context.sessionId, 'shutdown-owner');
    order.push('endpoint-received-release');
    acknowledge = () => { order.push('endpoint-sent-ack'); reply({ ok: true }); };
    releaseReceived.resolve();
  });
  const supervisor = new SubappOwnerSupervisor({
    resolveRuntime: () => endpoint.runtime,
    send: async binding => {
      order.push('request-release');
      await sendLifecycleRequest(binding);
      acknowledged = true;
      order.push('owner-release-acknowledged');
    },
    onError: (...args) => assert.fail(`Unexpected owner cleanup error: ${args[0]}`),
  });
  const contents = renderer();
  const input = { generation: supervisor.connect(contents).generation, ownerSessionId: 'shutdown-owner', toolId: 'fixture' };
  await supervisor.track(contents, input);
  const guard = supervisor.createOwnerGuard(contents, input);
  guard.attachCleanup(async () => { order.push('ordinary-cleanup'); });
  guard.attachCleanup(async () => { order.push('execution-cleanup'); }, { priority: 'execution' });
  const h = host({
    shutdownSubappOwners: () => { order.push('shutdown-owners'); return supervisor.shutdown(); },
    stopAllChildToolSessions: async () => {
      assert.equal(acknowledged, true, 'Runtime must remain alive until the owner ACK is received');
      order.push('stop-runtime');
      await endpoint.close();
      order.push('runtime-closed');
    },
    killAllCmdProcesses: async () => { order.push('process-fallback'); return true; },
  });
  h.begin(); h.begin();
  await releaseReceived.promise;
  await settle();
  assert.deepEqual(order, ['shutdown-owners', 'execution-cleanup', 'ordinary-cleanup', 'request-release', 'endpoint-received-release']);
  assert.equal(endpoint.listening, true);
  assert.equal(h.calls.includes('stop-npm'), false);
  assert.equal(h.completed, false);
  assert.equal(h.quits, 0);
  assert.throws(() => supervisor.connect(renderer(2)), { code: 'SUBAPP_HOST_SHUTTING_DOWN' });
  assert.throws(guard, { code: 'SUBAPP_RENDERER_EXPIRED' });
  acknowledge();
  await h.whenQuit;
  assert.deepEqual(order, ['shutdown-owners', 'execution-cleanup', 'ordinary-cleanup', 'request-release', 'endpoint-received-release',
    'endpoint-sent-ack', 'owner-release-acknowledged', 'stop-runtime', 'runtime-closed', 'process-fallback']);
  assert.deepEqual(await supervisor.shutdown(), { ok: true, remainingBindings: 0 });
  assert.equal(endpoint.listening, false);
  assert.equal(h.completed, true);
  assert.equal(h.quits, 1);
  assert.deepEqual(h.warnings, []);
});

test('a real ownerRelease failure is retried and reported before Runtime and command fallback', { timeout: 10000 }, async t => {
  const requests = [], ownerErrors = [], order = [];
  const endpoint = await lifecycleEndpoint(t, (request, reply) => {
    requests.push(request);
    order.push('release-rejected');
    reply({ ok: false, error: 'fixture owner release denied' });
  });
  const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => endpoint.runtime,
    onError: (...args) => ownerErrors.push(args) });
  const contents = renderer();
  const input = { generation: supervisor.connect(contents).generation, ownerSessionId: 'shutdown-owner', toolId: 'fixture' };
  await supervisor.track(contents, input);
  const h = host({
    shutdownSubappOwners: () => supervisor.shutdown(),
    stopAllChildToolSessions: async () => {
      order.push('stop-runtime');
      await endpoint.close();
    },
    killAllCmdProcesses: async () => { order.push('process-fallback'); return true; },
  });
  h.begin();
  await h.whenQuit;
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(request => request.id)).size, 3);
  assert.ok(requests.every(request => request.method === 'fixture.owner.release' && request.context.sessionId === 'shutdown-owner'));
  assert.deepEqual(order, ['release-rejected', 'release-rejected', 'release-rejected', 'stop-runtime', 'process-fallback']);
  assert.deepEqual(await supervisor.shutdown(), { ok: false, remainingBindings: 1 });
  assert.equal(supervisor.renderers.get(contents.id).bindings.size, 1);
  assert.equal(ownerErrors.length, 1);
  assert.equal(ownerErrors[0][1].error, 'fixture owner release denied');
  const unconfirmed = h.warnings.find(args => args[0] === '[PROC_TRACE][APP_OWNER_CLEANUP_UNCONFIRMED]');
  assert.ok(unconfirmed);
  assert.equal(unconfirmed[1].remainingBindings, 1);
  assert.ok(h.calls.includes('stop-npm'));
  assert.ok(h.calls.includes('release-auth'));
  assert.equal(h.completed, true);
  assert.equal(h.quits, 1);
});

test('owner and Runtime shutdown exceptions are logged without skipping generic cleanup', async () => {
  const order = [];
  const h = host({
    shutdownSubappOwners: async () => {
      order.push('shutdown-owners');
      throw Object.assign(new Error('fixture owner exception'), { code: 'FIXTURE_OWNER_FAILURE' });
    },
    stopAllChildToolSessions: async () => {
      order.push('stop-runtime');
      throw Object.assign(new Error('fixture Runtime exception'), { code: 'FIXTURE_RUNTIME_FAILURE' });
    },
    killAllCmdProcesses: async () => { order.push('process-fallback'); return true; },
  });
  h.begin();
  await h.whenQuit;
  assert.deepEqual(order, ['shutdown-owners', 'stop-runtime', 'process-fallback']);
  assert.deepEqual(h.warnings, [
    ['[PROC_TRACE][APP_OWNER_CLEANUP_ERROR]', 'FIXTURE_OWNER_FAILURE'],
    ['[PROC_TRACE][APP_CHILD_TOOL_CLEANUP_ERROR]', 'FIXTURE_RUNTIME_FAILURE'],
  ]);
  assert.ok(h.calls.includes('stop-npm'));
  assert.ok(h.calls.includes('release-auth'));
  assert.equal(h.completed, true);
  assert.equal(h.quits, 1);
});

test('native main-window close waits for process cleanup', () => {
  const win = source('window.js');
  const close = select(win, node => ts.isCallExpression(node) && node.expression.getText(win) === 'mainWindow.on'
    && node.arguments[0]?.text === 'close');
  const mainWindow = new EventEmitter();
  let complete = false, quits = 0, prevented = 0;
  vm.runInNewContext(close, { mainWindow, options: { canCloseMainWindow: () => complete },
    process: { platform: 'win32' }, applicationIsQuitting: false, app: { quit: () => { quits++; } } });
  mainWindow.emit('close', { preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1); assert.equal(quits, 1);
  complete = true;
  mainWindow.emit('close', { preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1); assert.equal(quits, 1);
});
