'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { SubappBrowserExecutionHost } = require('./subapp-browser-execution-host');
const { readBrowserExecutionSource, PROTOCOL } = require('./subapp-browser-execution-source');
const { createPackagedRendererServer } = require('./packaged-renderer-server');
const { SubappOwnerSupervisor } = require('./subapp-owner-supervisor');
const { registerBrowserExecutionHandlers } = require('./subapp-browser-execution-ipc');
const { SubappBrowserProcessBroker, REQUEST, RESULT } = require('./subapp-browser-process-broker');
const { SubappNodeControlBroker, TYPES: NODE_CONTROL_TYPES } = require('./subapp-node-control-broker');
const { readNodeControlSource, PROTOCOL: NODE_CONTROL_PROTOCOL } = require('./subapp-node-control-source');

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-browser-host-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'public', 'execution.html'), '<!doctype html><title>Execution</title>');
    fs.writeFileSync(path.join(dir, 'public', 'view.html'), '<!doctype html><title>View</title>');
    fs.writeFileSync(path.join(dir, 'public', 'core.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
    const declaration = { protocol: PROTOCOL, root: 'public', entry: 'execution.html',
        sha256: createHash('sha256').update(fs.readFileSync(path.join(dir, 'public', 'execution.html'))).digest('hex') };
    const manifest = { name: '@fixture/subapp', version: '1.2.3', ailySubapp: { runtime: { browserExecution: declaration },
        ui: { surfaces: { full: { entry: 'public/view.html' } } } } };
    const save = () => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest)); save();
    const config = { id: 'fixture', catalogId: 'fixture', version: manifest.version, packageName: manifest.name, packagePath: dir };
    return { dir, config, manifest, declaration, save, source: () => readBrowserExecutionSource(config) };
}

class Port extends EventEmitter {
    postMessage(data, ports = []) { if (this.closed) throw new Error('Port closed'); queueMicrotask(() => { if (!this.peer.closed) this.peer.emit('message', { data, ports }); }); }
    start() {} close() { this.closed = true; }
}
class Channel { constructor() { this.port1 = new Port(); this.port2 = new Port(); this.port1.peer = this.port2; this.port2.peer = this.port1; } }
let nextContents = 10;
class Contents extends EventEmitter {
    constructor() { super(); this.id = ++nextContents; this.url = ''; this.received = []; this.dead = false;
        this.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } }; }
    isDestroyed() { return this.dead; } getURL() { return this.url; } setWindowOpenHandler(handler) { this.popup = handler; }
    postMessage(channel, data, ports) { this.received.push({ channel, data, ports }); this.emit('delivered', { data, ports }); }
}

function harness(t, options = {}) {
    const f = fixture(t), windows = [], lifecycle = [], activePorts = new Map();
    let servers = 0, serverCloses = 0;
    const ready = options.ready || (() => true);
    class Window extends EventEmitter {
        constructor(opts) { super(); this.options = opts; this.webContents = new Contents(); this.dead = false; windows.push(this);
            this.webContents.on('delivered', ({ data, ports }) => {
                if (data.role !== 'host') return;
                const port = ports[0]; this.hostPort = port;
                port.on('message', ({ data: message, ports: attached }) => {
                    lifecycle.push(message);
                    if (message.type === 'attach') activePorts.set(message.connectionId, attached[0]);
                    if (message.type === 'detach') {
                        if (options.detachFailure?.()) { port.postMessage({ id: message.id, ok: false }); return; }
                        activePorts.get(message.connectionId)?.close(); activePorts.delete(message.connectionId);
                    }
                    if (message.type === 'shutdown') { for (const connection of activePorts.values()) connection.close(); activePorts.clear(); }
                    if (message.type === 'owner-release' && options.ownerReleaseFailure?.()) { port.postMessage({ id: message.id, ok: false }); return; }
                    if (!options.ignore?.(message)) port.postMessage({ id: message.id, ok: true, value: { resources: 0 } });
                });
                if (ready()) port.postMessage({ type: 'ready', protocol: PROTOCOL });
            });
        }
        async loadURL(url) { this.webContents.url = url; await options.load?.(this); }
        isDestroyed() { return this.dead; } show() { this.shown = true; }
        destroy() { if (this.dead) return; this.dead = true; this.webContents.dead = true;
            this.webContents.emit('destroyed'); this.emit('closed'); }
    }
    const host = new SubappBrowserExecutionHost({ BrowserWindow: Window, MessageChannelMain: Channel, timeoutMs: options.timeoutMs || 100,
        createServer: () => ({ async start() { servers++; await options.serverStart?.(); return { origin: 'http://127.0.0.1:49152' }; },
            async close() { serverCloses++; if (options.serverCloseFailure?.()) throw new Error('Static listener close unconfirmed'); } }) });
    const runtimeId = 'registered-fixture-stream', source = f.source();
    function owner(id = 1, leaseId = randomUUID()) {
        let valid = true; const cleanups = new Set();
        const guard = () => { if (!valid) throw new Error('Owner revoked'); };
        Object.assign(guard, { runtime: { streamId: runtimeId }, ownerSessionId: leaseId,
            attachCleanup(cleanup) { guard(); cleanups.add(cleanup); return () => cleanups.delete(cleanup); } });
        return { runtimeId, source, ownerId: id, leaseId, guard, cleanups,
            async revoke() { valid = false; for (const cleanup of [...cleanups]) { await cleanup(); cleanups.delete(cleanup); } } };
    }
    t.after(() => host.closeAll());
    return { ...f, source, host, windows, lifecycle, activePorts, owner, runtimeId,
        get serverCloses() { return serverCloses; }, get servers() { return servers; } };
}

test('only a selected package version, bounded local entry and matching HTML hash can execute', t => {
    const f = fixture(t); assert.equal(f.source().version, '1.2.3');
    assert.throws(() => readBrowserExecutionSource({ ...f.config, version: '2.0.0' }), /identity/);
    for (const entry of ['../outside.html', 'https://remote/entry.html', '/absolute.html', 'x\\entry.html', 'x%2fentry.html']) {
        f.declaration.entry = entry; f.save(); assert.throws(f.source);
    }
    f.declaration.entry = 'execution.html'; f.declaration.sha256 = '0'.repeat(64); f.save(); assert.throws(f.source, /integrity/);
    f.declaration.sha256 = createHash('sha256').update(fs.readFileSync(path.join(f.dir, 'public/execution.html'))).digest('hex');
    f.manifest.ailySubapp.runtime.headless = true; f.save(); assert.throws(f.source, /supported/);
});

test('Node control is disabled unless the Main-selected installed package declares the exact registered protocol', t => {
    const f = fixture(t);
    assert.equal(readNodeControlSource(f.config), null);
    f.manifest.ailySubapp.runtime.nodeControl = { protocol: NODE_CONTROL_PROTOCOL }; f.save();
    assert.throws(() => readNodeControlSource(f.config), /requires a registered/);
    f.manifest.ailySubapp.runtime.processMessagePort = { transport: 'node-ipc-v1', maxMessageBytes: 2 * 1024 * 1024 }; f.save();
    const selected = readNodeControlSource(f.config);
    assert.equal(selected.maxMessageBytes, 1024 * 1024); assert.equal(selected.packageName, f.manifest.name);
    assert.equal(Object.isFrozen(selected), true);
    assert.throws(() => readNodeControlSource({ ...f.config, version: 'other-version' }), /identity changed/);
    f.manifest.ailySubapp.runtime.nodeControl.owner = 'renderer-selected'; f.save();
    assert.throws(() => readNodeControlSource(f.config), /Unsupported/);
    f.manifest.ailySubapp.runtime.nodeControl = { protocol: 'unregistered-protocol' }; f.save();
    assert.throws(() => readNodeControlSource(f.config), /Unsupported/);
});

test('concurrent owners share one sandbox execution document and pinned version', async t => {
    const h = harness(t), a = h.owner(), b = h.owner(2);
    const [one, two] = await Promise.all([h.host.acquire(a), h.host.acquire(b)]);
    assert.equal(one.executionId, two.executionId); assert.equal(h.windows.length, 1); assert.equal(h.servers, 1);
    assert.equal(two.refCount, 2);
    const prefs = h.windows[0].options.webPreferences;
    assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegrationInWorker, false); assert.equal(prefs.backgroundThrottling, false);
    await assert.rejects(h.host.acquire({ ...b, source: { ...h.source, identity: 'different-build' } }), /pinned/);
    await a.revoke(); assert.equal(h.windows[0].isDestroyed(), false); assert.equal(h.host.runtimes.size, 1);
    const closed = await b.revoke(); assert.equal(closed, undefined); assert.equal(h.windows[0].isDestroyed(), true);
    assert.equal(h.host.runtimes.size, 0); assert.equal(h.serverCloses, 1);
});

test('late View receives its direct peer port; destroying View detaches only that connection', async t => {
    const h = harness(t), a = h.owner(); const acquired = await h.host.acquire(a);
    const connection = await h.host.openView({ ...a, executionId: acquired.executionId, surface: 'full' }, { show: false });
    const view = h.windows[1], handed = view.webContents.received[0];
    assert.equal(handed.data.connectionId, connection.connectionId); assert.equal(view.shown, undefined);
    const peer = h.activePorts.get(connection.connectionId), actual = handed.ports[0];
    const received = new Promise(resolve => actual.once('message', ({ data }) => resolve(data)));
    peer.postMessage({ snapshot: { sessionId: 'same-domain-session', cursor: 17 } });
    assert.deepEqual(await received, { snapshot: { sessionId: 'same-domain-session', cursor: 17 } });
    view.destroy(); await tick(); await tick();
    assert.equal(h.activePorts.size, 0); assert.equal(h.windows[0].isDestroyed(), false); assert.equal(h.host.runtimes.size, 1);
    const reattached = await h.host.openView({ ...a, executionId: acquired.executionId, surface: 'full' }, { show: false });
    assert.equal(reattached.executionId, acquired.executionId); assert.equal(h.windows.length, 3);
    const receipt = await h.host.closeView({ ...a, ...reattached }); assert.equal(receipt.physicalClosed, true);
});

test('owner A release closes only A ports/Views and leaves B execution usable', async t => {
    const h = harness(t), a = h.owner(), b = h.owner(2);
    const acquired = await h.host.acquire(a); await h.host.acquire(b);
    await h.host.openView({ ...a, executionId: acquired.executionId, surface: 'full' }, { show: false });
    const target = new Contents(); target.id = b.ownerId;
    await h.host.connect({ ...b, executionId: acquired.executionId, target });
    assert.equal((await h.host.release(a)).refCount, 1); assert.equal(h.windows[1].isDestroyed(), true);
    assert.equal(h.activePorts.size, 1); assert.equal(h.windows[0].isDestroyed(), false);
    const closed = await h.host.release(b);
    assert.equal(closed.acknowledged, true); assert.equal(closed.physicalClosed, true); assert.equal(closed.value.resources, 0);
    assert.equal(h.activePorts.size, 0); assert.equal(h.host.runtimes.size, 0);
});

test('stale handle, unrelated renderer and untrusted View origin/version never receive ports', async t => {
    const h = harness(t), a = h.owner(), acquired = await h.host.acquire(a), target = new Contents();
    await assert.rejects(h.host.connect({ ...a, executionId: acquired.executionId, target }), /owning/);
    target.url = 'https://remote.example/view.html';
    await assert.rejects(h.host.connect({ ...a, executionId: acquired.executionId, target, purpose: 'view', surface: 'full' }), /trusted/);
    target.url = 'http://127.0.0.1:49152/view.html?token=forged';
    await assert.rejects(h.host.connect({ ...a, executionId: acquired.executionId, target, purpose: 'view', surface: 'full' }), /trusted/);
    target.id = a.ownerId;
    await assert.rejects(h.host.connect({ ...a, executionId: randomUUID(), target }), /unavailable/);
    assert.equal(target.received.length, 0);
});

test('revoke during server startup joins the pending start and closes the late listener', async t => {
    const gate = Promise.withResolvers(), h = harness(t, { serverStart: () => gate.promise }), a = h.owner();
    const acquisition = h.host.acquire(a); const failed = assert.rejects(acquisition, /cancelled|expired/);
    const revoked = a.revoke(); gate.resolve(); await Promise.all([failed, revoked]);
    assert.equal(h.serverCloses, 1); assert.equal(h.windows.length, 0); assert.equal(h.host.runtimes.size, 0);
});

test('revoke while waiting for ready is bounded and cannot resurrect an execution', async t => {
    const h = harness(t, { ready: () => false }), a = h.owner();
    const acquisition = h.host.acquire(a), failed = assert.rejects(acquisition, /closed|expired/);
    await tick(); await a.revoke(); await failed;
    assert.equal(h.windows[0].isDestroyed(), true); assert.equal(h.serverCloses, 1); assert.equal(h.host.runtimes.size, 0);
});

test('unresponsive startup and shutdown physically close their owned documents/listeners', async t => {
    const h = harness(t, { ready: () => false, timeoutMs: 15 });
    await assert.rejects(h.host.acquire(h.owner()), /deadline/);
    assert.equal(h.windows[0].isDestroyed(), true); assert.equal(h.serverCloses, 1);
    const other = harness(t, { ignore: message => message.type === 'shutdown', timeoutMs: 15 }), owner = other.owner();
    await other.host.acquire(owner); const closed = await other.host.release(owner);
    assert.equal(closed.acknowledged, false); assert.equal(closed.physicalClosed, true); assert.equal(other.host.runtimes.size, 0);
});

test('unacknowledged detach remains attached to owner cleanup and is retryable', async t => {
    let fail = true; const h = harness(t, { detachFailure: () => fail }), a = h.owner(), b = h.owner(2);
    const acquired = await h.host.acquire(a); await h.host.acquire(b);
    await h.host.openView({ ...a, executionId: acquired.executionId, surface: 'full' }, { show: false });
    await assert.rejects(a.revoke(), /not acknowledged/);
    assert.equal(a.cleanups.size, 1); assert.equal(h.activePorts.size, 1); assert.equal(h.windows[0].isDestroyed(), false);
    fail = false; await a.revoke(); assert.equal(a.cleanups.size, 0); assert.equal(h.activePorts.size, 0);
    await b.revoke(); assert.equal(h.host.runtimes.size, 0);
});

test('release fences a held attach before its ACK and rejects same-owner reacquire while B keeps execution alive', async t => {
    const h = harness(t, { ignore: message => ['attach', 'detach'].includes(message.type) });
    const a = h.owner(), b = h.owner(2), acquired = await h.host.acquire(a); await h.host.acquire(b);
    const target = new Contents(); target.id = a.ownerId;
    const attaching = h.host.connect({ ...a, executionId: acquired.executionId, target });
    const rejected = assert.rejects(attaching, /ended during attachment/);
    await tick(); const releasing = h.host.release(a); await tick();
    await assert.rejects(h.host.acquire(a), /pinned/);
    const attach = h.lifecycle.find(message => message.type === 'attach');
    const detach = h.lifecycle.find(message => message.type === 'detach');
    h.windows[0].hostPort.postMessage({ id: attach.id, ok: true }); await tick();
    assert.equal(target.received.length, 0, 'A must not receive the port after execution-owner release began');
    h.windows[0].hostPort.postMessage({ id: detach.id, ok: true });
    await rejected; assert.equal((await releasing).refCount, 1);
    assert.equal(h.windows[0].isDestroyed(), false); assert.equal(target.received.length, 0);
});

test('execution crash revokes all connections and physically closes its static source', async t => {
    const h = harness(t), a = h.owner(); await h.host.acquire(a);
    h.windows[0].webContents.emit('render-process-gone'); await tick(); await tick();
    assert.equal(h.windows[0].isDestroyed(), true); assert.equal(h.serverCloses, 1); assert.equal(h.host.runtimes.size, 0);
});

test('owned static server applies isolation and finite files, denying symlink/traversal/dotfiles/unknown types', async t => {
    const f = fixture(t), server = createPackagedRendererServer({ indexFile: 'execution.html', crossOriginIsolated: true,
        strictPublicFiles: true, contentSecurityPolicy: "default-src 'self'" });
    const state = await server.start({ rootDirectory: path.join(f.dir, 'public') }); t.after(() => server.close());
    const wasm = await fetch(state.origin + '/core.wasm'); assert.equal(wasm.status, 200);
    assert.equal(wasm.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.equal(wasm.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    assert.equal(wasm.headers.get('content-security-policy'), "default-src 'self'");
    fs.writeFileSync(path.join(f.dir, 'public', '.hidden.json'), '{}'); fs.writeFileSync(path.join(f.dir, 'public', 'secret.cjs'), '');
    for (const relative of ['.hidden.json', 'secret.cjs', '%2e%2e%2fpackage.json']) {
        assert.notEqual((await fetch(state.origin + '/' + relative)).status, 200);
    }
    // A directory junction needs no Windows symlink privilege and exercises intermediate components.
    fs.symlinkSync(path.join(f.dir, 'public'), path.join(f.dir, 'public', 'linked'), 'junction');
    assert.equal((await fetch(state.origin + '/linked/core.wasm')).status, 404);
    fs.writeFileSync(path.join(f.dir, 'public', 'large.bin'), Buffer.alloc(8 * 1024 * 1024));
    const http = require('node:http');
    let stalledRequest;
    const stalled = await new Promise((resolve, reject) => {
        stalledRequest = http.get(state.origin + '/large.bin', response => { response.pause(); resolve(response); });
        stalledRequest.on('error', reject);
    });
    t.after(() => { stalled.destroy(); stalledRequest.destroy(); });
    let timer;
    await Promise.race([server.close(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned server retained stalled public file socket')), 1000);
    })]).finally(() => clearTimeout(timer));
    stalled.destroy(); stalledRequest.destroy(); await assert.rejects(fetch(state.origin));
});

test('IPC requires a real acknowledged registered-owner guard and returns only an opaque endpoint', async t => {
    const h = harness(t), renderer = new Contents(), methods = new Map(); renderer.mainFrame = {};
    const runtime = { streamId: h.runtimeId, nativeOwnerControl: true, hostInfo: { wsUrl: 'ws://127.0.0.1:49151/ws?token=not-public', runtimeConfig: h.config } };
    const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => runtime });
    const input = { generation: supervisor.connect(renderer).generation, ownerSessionId: randomUUID(), toolId: 'fixture' };
    const event = { sender: renderer, senderFrame: renderer.mainFrame }; let selections = 0, released = 0;
    registerBrowserExecutionHandlers({ ipcMain: { handle: (name, handler) => methods.set(name, handler) }, host: h.host, supervisor,
        resolveRuntime: () => runtime, prepareLaunch: async () => { selections++; return { config: h.config, release() { released++; } }; } });
    const invoke = payload => methods.get('subapp-browser-execution')(event, { ...input, ...payload });
    await assert.rejects(invoke({ action: 'acquire' }), /binding has ended/);
    await supervisor.track(renderer, input);
    const acquired = await invoke({ action: 'acquire', url: 'https://attacker', packagePath: 'C:/attacker' });
    assert.deepEqual(Object.keys(acquired), ['endpoint', 'version']); assert.equal(acquired.endpoint.kind, 'browser-message-port');
    assert.match(acquired.endpoint.runtimeId, /^[a-f0-9-]{36}$/); assert.equal(selections, 1); assert.equal(released, 1);
    assert.equal(JSON.stringify(acquired).includes('127.0.0.1'), false); assert.equal(JSON.stringify(acquired).includes('token'), false);
    await invoke({ action: 'connect', runtimeId: acquired.endpoint.runtimeId }); assert.equal(renderer.received.length, 1);
    // A document crash ends the opaque endpoint while the registered Node owner can
    // remain live. Reacquire must create a new instance, not return a stale cache.
    h.windows[0].webContents.emit('render-process-gone'); await tick(); await tick();
    const replacement = await invoke({ action: 'acquire' });
    assert.notEqual(replacement.endpoint.runtimeId, acquired.endpoint.runtimeId); assert.equal(selections, 2); assert.equal(released, 2);
    await assert.rejects(invoke({ action: 'connect', runtimeId: acquired.endpoint.runtimeId }), /stale/);
    const releasedOwner = await supervisor.release(renderer, input); assert.equal(releasedOwner.ok, true); assert.equal(h.host.runtimes.size, 0);
    await assert.rejects(invoke({ action: 'connect', runtimeId: acquired.endpoint.runtimeId }), /binding has ended/);
});

test('IPC concurrent acquire shares selection; release fences reacquire until its physical close receipt', async t => {
    const h = harness(t, { ignore: message => message.type === 'shutdown' }), renderer = new Contents(), handlers = new Map(); renderer.mainFrame = {};
    const runtime = { streamId: h.runtimeId, nativeOwnerControl: true, hostInfo: { wsUrl: 'ws://127.0.0.1:49151/ws', runtimeConfig: h.config } };
    const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => runtime });
    const input = { generation: supervisor.connect(renderer).generation, ownerSessionId: randomUUID(), toolId: 'fixture' };
    await supervisor.track(renderer, input);
    const selected = Promise.withResolvers(); let selectionCount = 0;
    registerBrowserExecutionHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, host: h.host, supervisor,
        resolveRuntime: () => runtime, prepareLaunch: async () => { selectionCount++; await selected.promise; return { config: h.config, release() {} }; } });
    const invoke = payload => handlers.get('subapp-browser-execution')({ sender: renderer, senderFrame: renderer.mainFrame }, { ...input, ...payload });
    const first = invoke({ action: 'acquire' }), second = invoke({ action: 'acquire' });
    assert.equal(selectionCount, 1); selected.resolve(); const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b);
    const releasing = invoke({ action: 'release', runtimeId: a.endpoint.runtimeId }); await tick();
    await assert.rejects(invoke({ action: 'acquire' }), /being released/);
    const shutdown = h.lifecycle.find(message => message.type === 'shutdown');
    h.windows[0].hostPort.postMessage({ id: shutdown.id, ok: true });
    assert.equal((await releasing).physicalClosed, true); assert.equal(h.host.runtimes.size, 0);
});

test('real supervised IPC bindProcess returns an owner-scoped JSON capability and routes only its registered process', async t => {
    const h = harness(t), renderer = new Contents(), handlers = new Map(), sent = []; renderer.mainFrame = {};
    const runtime = { streamId: h.runtimeId, nativeOwnerControl: true, messagePort: { maxMessageBytes: 4096 },
        hostInfo: { wsUrl: 'ws://127.0.0.1:49151/ws', runtimeConfig: h.config } };
    const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => runtime });
    const input = { generation: supervisor.connect(renderer).generation, ownerSessionId: randomUUID(), toolId: 'fixture' };
    const broker = new SubappBrowserProcessBroker({ host: h.host, send: async (stream, message) => { sent.push({ stream, message }); },
        resolveStream: stream => stream === runtime.streamId ? { toolId: 'fixture', messagePort: runtime.messagePort } : null });
    registerBrowserExecutionHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, host: h.host, supervisor, broker,
        resolveRuntime: () => runtime, prepareLaunch: async () => ({ config: h.config, release() {} }) });
    const invoke = payload => handlers.get('subapp-browser-execution')({ sender: renderer, senderFrame: renderer.mainFrame }, { ...input, ...payload });
    await assert.rejects(invoke({ action: 'bindProcess', ownerSessionId: 'forged' }), /binding has ended/);
    await supervisor.track(renderer, input);
    const [one, same] = await Promise.all([invoke({ action: 'bindProcess' }), invoke({ action: 'bindProcess' })]);
    assert.deepEqual(one, same); assert.deepEqual(Object.keys(one), ['endpoint', 'connectionId']); assert.equal(JSON.stringify(one).includes('127.0.0.1'), false);
    assert.equal(renderer.received.length, 0, 'Node binding never hands the private execution port to a renderer');
    const request = { type: REQUEST, version: 1, runtimeId: one.endpoint.runtimeId, connectionId: one.connectionId, requestId: 'finite', payload: {} };
    broker.handle(runtime.streamId, request); await tick();
    h.activePorts.get(one.connectionId).postMessage({ ...request, type: RESULT, ok: true, result: { snapshot: 'bounded' } }); await tick();
    assert.equal(sent.at(-1).stream, runtime.streamId); assert.deepEqual(sent.at(-1).message.result, { snapshot: 'bounded' });
    await supervisor.release(renderer, input);
    assert.equal(h.host.runtimes.size, 0); assert.equal(broker.connections.size, 0); assert.equal(broker.pendingCount, 0);
});

test('opted-in installed View gets an independent private Node port; close failure remains joined and retryable', async t => {
    const h = harness(t), renderer = new Contents(), handlers = new Map(), sent = []; renderer.mainFrame = {};
    h.manifest.ailySubapp.runtime.nodeControl = { protocol: NODE_CONTROL_PROTOCOL };
    h.manifest.ailySubapp.runtime.processMessagePort = { transport: 'node-ipc-v1', maxMessageBytes: 1024 * 1024 }; h.save();
    const runtime = { streamId: h.runtimeId, nativeOwnerControl: true, messagePort: { maxMessageBytes: 1024 * 1024 },
        hostInfo: { wsUrl: 'ws://127.0.0.1:49151/ws', runtimeConfig: h.config } };
    const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => runtime });
    const input = { generation: supervisor.connect(renderer).generation, ownerSessionId: randomUUID(), toolId: 'fixture' };
    const broker = new SubappBrowserProcessBroker({ host: h.host, send: async () => ({ success: true }),
        resolveStream: stream => stream === runtime.streamId ? { toolId: 'fixture', messagePort: runtime.messagePort } : null });
    let detachFails = true;
    const nodeControlBroker = new SubappNodeControlBroker({ MessageChannelMain: Channel, timeoutMs: 100,
        resolveRuntime: stream => stream === runtime.streamId ? runtime : null,
        send: async (stream, frame) => {
            sent.push({ stream, frame }); const ok = frame.type !== NODE_CONTROL_TYPES.detach || !detachFails;
            queueMicrotask(() => nodeControlBroker.handle(stream, { type: frame.type === NODE_CONTROL_TYPES.attach ? NODE_CONTROL_TYPES.attached : NODE_CONTROL_TYPES.detached,
                version: 1, runtimeId: frame.runtimeId, connectionId: frame.connectionId, requestId: frame.requestId, ok,
                ...(!ok ? { errorCode: 'FIXTURE_FAILURE', error: 'Actual Node detach failed' } : {}) }));
            return { success: true };
        } });
    t.after(async () => { detachFails = false; await nodeControlBroker.closeAll(); });
    registerBrowserExecutionHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, host: h.host, supervisor, broker, nodeControlBroker,
        resolveRuntime: () => runtime, prepareLaunch: async () => ({ config: h.config, release() {} }) });
    const invoke = payload => handlers.get('subapp-browser-execution')({ sender: renderer, senderFrame: renderer.mainFrame }, { ...input, ...payload });
    await supervisor.track(renderer, input);
    const acquired = await invoke({ action: 'acquire' });
    const view = await invoke({ action: 'openView', runtimeId: acquired.endpoint.runtimeId, surface: 'full', owner: 'forged', url: 'http://attacker' });
    const target = h.windows[1].webContents;
    assert.deepEqual(target.received.map(frame => frame.channel), ['subapp-browser-execution-port', 'subapp-node-control-port']);
    const attachment = sent.find(item => item.frame.type === NODE_CONTROL_TYPES.attach);
    assert.equal(attachment.stream, runtime.streamId); assert.equal(attachment.frame.packageName, h.config.packageName);
    assert.equal(attachment.frame.context.sessionId, input.ownerSessionId);
    assert.deepEqual(attachment.frame.context.browserExecution.endpoint, acquired.endpoint);
    assert.equal(attachment.frame.context.browserExecution.connectionId, [...broker.connections.keys()][0]);
    assert.equal(JSON.stringify(target.received.at(-1).data).includes(input.ownerSessionId), false);
    await assert.rejects(invoke({ action: 'closeView', runtimeId: acquired.endpoint.runtimeId, connectionId: view.connectionId }), /cleanup was not acknowledged/);
    assert.equal(h.windows[1].isDestroyed(), false); assert.equal(nodeControlBroker.connections.size, 1);
    assert.equal(h.host.runtimes.get(runtime.streamId).connections.size, 2);
    detachFails = false;
    await invoke({ action: 'closeView', runtimeId: acquired.endpoint.runtimeId, connectionId: view.connectionId });
    assert.equal(h.windows[1].isDestroyed(), true); assert.equal(nodeControlBroker.connections.size, 0);
    assert.equal(h.host.runtimes.size, 1); assert.equal(broker.connections.size, 1);
    await supervisor.release(renderer, input);
    assert.equal(h.host.runtimes.size, 0); assert.equal(broker.connections.size, 0);
});

test('private owner handle survives connection replacement/View close; only actual owner departure releases domain holds', async t => {
    const h = harness(t), a = h.owner(), b = h.owner(2), acquired = await h.host.acquire(a); await h.host.acquire(b);
    const first = await h.host.connectRuntime({ ...a, executionId: acquired.executionId });
    const handle = h.lifecycle.find(message => message.type === 'attach').ownerHandle;
    assert.match(handle, /^[a-f0-9-]{36}$/); assert.notEqual(handle, a.leaseId);
    assert.equal(JSON.stringify(acquired).includes(handle), false);
    await first.close();
    await h.host.connectRuntime({ ...a, executionId: acquired.executionId });
    const view = await h.host.openView({ ...a, executionId: acquired.executionId, surface: 'full' }, { show: false });
    await h.host.closeView({ ...a, ...view });
    assert.equal(h.lifecycle.filter(message => message.type === 'owner-release').length, 0);
    assert.ok(h.lifecycle.filter(message => message.type === 'attach').every(message => message.ownerHandle === handle));
    assert.equal((await h.host.release(a)).refCount, 1);
    assert.deepEqual(h.lifecycle.filter(message => message.type === 'owner-release').map(message => message.ownerHandle), [handle]);
    assert.equal(h.windows[0].isDestroyed(), false);
});

test('failed private owner release retains its owner/handle and cleanup for retry while another owner runs', async t => {
    let fail = true; const h = harness(t, { ownerReleaseFailure: () => fail }), a = h.owner(), b = h.owner(2);
    await h.host.acquire(a); await h.host.acquire(b);
    await assert.rejects(a.revoke(), /lifecycle request failed/);
    const state = h.host.runtimes.get(a.runtimeId);
    assert.equal(state.owners.size, 2); assert.equal(state.ownerHandles.size, 2); assert.equal(a.cleanups.size, 1);
    assert.equal(h.host.isCurrent({ ...a, executionId: state.executionId }), false);
    assert.equal(h.host.isCurrent({ ...b, executionId: state.executionId }), true);
    fail = false; await a.revoke(); assert.equal(state.owners.size, 1); assert.equal(state.ownerHandles.size, 1);
    await b.revoke(); assert.equal(h.host.runtimes.size, 0);
});

test('final physical listener close failure retains owner cleanup even after domain owner-release ACK', async t => {
    let fail = true; const h = harness(t, { serverCloseFailure: () => fail }), a = h.owner(); await h.host.acquire(a);
    await assert.rejects(h.host.release(a), /listener close unconfirmed/);
    assert.equal(h.host.runtimes.size, 1); assert.equal(a.cleanups.size, 1);
    fail = false; await a.revoke(); assert.equal(h.host.runtimes.size, 0); assert.equal(a.cleanups.size, 0);
});

test('strict static server retains a failed close resource until a subsequent real close acknowledgement', async t => {
    const f = fixture(t); let fail = true, attempts = 0;
    const serverInstance = Object.assign(new EventEmitter(), { listening: false,
        listen() { this.listening = true; queueMicrotask(() => this.emit('listening')); },
        address() { return { port: 49153 }; },
        close(callback) { attempts++; if (fail) callback(new Error('Controlled socket close failure')); else { this.listening = false; callback(); } },
        closeAllConnections() {},
    });
    const server = createPackagedRendererServer({ strictPublicFiles: true, indexFile: 'execution.html', createHttpServer: () => serverInstance });
    await server.start({ rootDirectory: path.join(f.dir, 'public') });
    await assert.rejects(server.close(), /socket close failure/);
    assert.equal(server.status().state, 'ready'); assert.equal(serverInstance.listening, true);
    fail = false; await server.close(); assert.equal(attempts, 2); assert.equal(server.status().state, 'stopped');
});
