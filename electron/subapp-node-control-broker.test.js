'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { SubappNodeControlBroker, TYPES, PROTOCOL } = require('./subapp-node-control-broker');
const { normalizeProcessMessage } = require('./child-process-message-port');

class Port extends EventEmitter {
    postMessage(data, ports = []) { if (this.closed) throw new Error('Closed'); queueMicrotask(() => { if (!this.peer.closed) this.peer.emit('message', { data, ports }); }); }
    start() {} close() { this.closed = true; }
}
class Channel { constructor() { this.port1 = new Port(); this.port2 = new Port(); this.port1.peer = this.port2; this.port2.peer = this.port1; } }
class Target extends EventEmitter {
    isDestroyed() { return false; }
    postMessage(channel, data, ports) { this.delivery = { channel, data, ports }; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error('Finite fixture condition failed'); };
function fixture(t, options = {}) {
    const sent = [], cleanup = new Set(), target = new Target(), runtimeId = randomUUID(), streamId = 'registered-node-fixture';
    let valid = true, alive = true, detachFails = false, sendFails = false, holdAttach = false, holdDetach = false, broker;
    const lease = { runtimeId: streamId, executionId: runtimeId, ownerId: 11, leaseId: randomUUID() };
    const guard = () => { if (!valid) throw new Error('Owner ended'); };
    Object.assign(guard, { runtime: { streamId }, ownerSessionId: lease.leaseId,
        attachCleanup(fn) { guard(); cleanup.add(fn); return () => cleanup.delete(fn); } });
    const source = { protocol: PROTOCOL, packageName: '@fixture/installed', version: '1.0.0', maxMessageBytes: 1024 * 1024 };
    const outcome = (frame, result, ok = true) => broker.handle(streamId, { type: frame.type === TYPES.attach ? TYPES.attached : frame.type === TYPES.detach ? TYPES.detached : TYPES.result,
        version: 1, runtimeId, connectionId: frame.connectionId, requestId: frame.requestId, ok,
        ...(ok ? frame.type === TYPES.request ? { result } : {} : { errorCode: 'FIXTURE_FAILURE', error: 'Cleanup failed' }) });
    const send = async (_stream, frame) => {
        sent.push(frame);
        if (sendFails && frame.type === TYPES.request) return { success: false, reason: 'message-send-failed' };
        if (frame.type === TYPES.attach && !holdAttach) queueMicrotask(() => outcome(frame));
        if (frame.type === TYPES.detach && !holdDetach) queueMicrotask(() => outcome(frame, undefined, !detachFails));
        if (frame.type === TYPES.request && options.echo) queueMicrotask(() => outcome(frame, { echoed: frame.payload }));
        return { success: true };
    };
    broker = new SubappNodeControlBroker({ MessageChannelMain: Channel, send: options.send || send,
        resolveRuntime: () => alive ? { messagePort: { maxMessageBytes: 2 * 1024 * 1024 } } : null,
        timeoutMs: options.timeoutMs || 100, cancelGraceMs: 50 });
    t.after(async () => { valid = true; detachFails = false; holdDetach = false; if (holdAttach) { holdAttach = false; for (const frame of sent.filter(x => x.type === TYPES.attach)) outcome(frame); }
        await broker.closeAll(); });
    function connect() { const opened = broker.connectView({ lease, guard, source, target, assertCurrent: guard,
        browserExecution: { endpoint: { kind: 'browser-message-port', runtimeId }, connectionId: randomUUID() } });
        const replies = []; opened.ready.then(() => target.delivery.ports[0].on('message', ({ data }) => replies.push(data)), () => {});
        return { ...opened, replies, frame: (type, requestId, extra = {}) => ({ type, version: 1, runtimeId, connectionId: opened.connectionId, requestId, ...extra }),
            post(frame) { target.delivery.ports[0].postMessage(frame); } }; }
    return { broker, connect, sent, cleanup, target, lease, guard, source, outcome,
        revoke() { valid = false; }, holdAttach() { holdAttach = true; }, failDetach(value) { detachFails = value; }, failSend(value) { sendFails = value; },
        holdDetach(value) { holdDetach = value; },
        exit() { alive = false; broker.runtimeExited(streamId); } };
}

test('only Main private attachment supplies context; installed View receives no Node/owner/URL capability', async t => {
    const f = fixture(t, { echo: true }), c = f.connect(); await c.ready;
    assert.equal(f.target.delivery.channel, 'subapp-node-control-port');
    assert.equal(f.sent[0].context.sessionId, f.lease.leaseId);
    assert.equal(f.sent[0].context.actor, 'view');
    assert.deepEqual(Object.keys(f.target.delivery.data).sort(), ['protocol', 'version', 'role', 'runtimeId', 'connectionId', 'packageName', 'packageVersion'].sort());
    c.post(c.frame(TYPES.request, 'request-one', { timeoutMs: 1000, payload: { method: 'fixture.read' } }));
    await until(() => c.replies.length === 1); assert.equal(c.replies[0].ok, true);
    assert.deepEqual(c.replies[0].result, { echoed: { method: 'fixture.read' } });
    await c.close(); assert.equal(f.broker.connections.size, 0); assert.equal(f.cleanup.size, 0);
});

test('exact frames, fixed identity, 1MiB and sixteen pending slots reject before forwarding', async t => {
    const f = fixture(t), c = f.connect(); await c.ready;
    for (let i = 0; i < 16; i++) c.post(c.frame(TYPES.request, 'p' + i, { timeoutMs: 30000, payload: {} }));
    await until(() => f.broker.pendingCount === 16);
    c.post(c.frame(TYPES.request, 'overflow', { timeoutMs: 30000, payload: {} }));
    c.post(c.frame(TYPES.request, 'extra', { timeoutMs: 1000, payload: {}, ownerId: 'invented' }));
    c.post(c.frame(TYPES.request, 'wrong-runtime', { timeoutMs: 1000, payload: {}, runtimeId: randomUUID() }));
    c.post(c.frame(TYPES.request, 'large', { timeoutMs: 1000, payload: { body: 'x'.repeat(1024 * 1024) } }));
    c.post(c.frame(TYPES.detach, 'private-lifecycle'));
    await until(() => c.replies.length === 5);
    assert.equal(c.replies[0].errorCode, 'NODE_CONTROL_BUSY');
    assert.equal(f.sent.filter(x => x.type === TYPES.request).length, 16);
    assert.equal(f.broker.pendingCount, 16); await c.close(); assert.equal(f.broker.pendingBytes, 0);
});

test('cancel is not terminal and result must come from the exact registered stream and tuple', async t => {
    const f = fixture(t), c = f.connect(); await c.ready;
    const frame = c.frame(TYPES.request, 'held', { timeoutMs: 1000, payload: {} }); c.post(frame);
    await until(() => f.broker.pendingCount === 1); c.post(c.frame(TYPES.cancel, 'held')); await tick();
    assert.equal(c.replies.length, 0); assert.equal(f.broker.pendingCount, 1);
    assert.equal(f.broker.handle('other-process', { ...frame, type: TYPES.result, ok: true, result: null }), true);
    assert.equal(c.replies.length, 0); f.outcome(frame, { actual: 'terminal' });
    await until(() => c.replies.length === 1); assert.equal(c.replies[0].errorCode, 'NODE_CONTROL_CANCELLED');
    assert.equal(f.broker.pendingCount, 0);
});

test('failed detach keeps real cleanup and budgets available for retry, not a fake ACK', async t => {
    const f = fixture(t), c = f.connect(); await c.ready;
    c.post(c.frame(TYPES.request, 'held', { timeoutMs: 1000, payload: {} })); await until(() => f.broker.pendingCount === 1);
    f.failDetach(true); await assert.rejects(c.close(), /Cleanup failed/);
    assert.equal(f.broker.connections.size, 1); assert.equal(f.broker.pendingCount, 1); assert.equal(f.cleanup.size, 1);
    assert.equal(c.replies[0].errorCode, 'NODE_CONTROL_CLEANUP_UNCONFIRMED');
    f.failDetach(false); await c.close(); assert.equal(f.broker.connections.size, 0); assert.equal(f.broker.pendingCount, 0);
});

test('a missing lifecycle ACK has a finite deadline and retains its actual cleanup until retry', async t => {
    const f = fixture(t), c = f.connect(); await c.ready; f.holdDetach(true);
    await assert.rejects(c.close(), /ACK timed out/);
    assert.equal(f.broker.connections.size, 1); assert.equal(f.cleanup.size, 1);
    f.holdDetach(false); await c.close(); assert.equal(f.broker.connections.size, 0); assert.equal(f.cleanup.size, 0);
});

test('a request deadline only sends cancel; a terminal result still waits for the actual send callback', async t => {
    let f, releaseSend;
    f = fixture(t, { send: async (_stream, frame) => {
        if (frame.type === TYPES.request) {
            queueMicrotask(() => f.outcome(frame, { actual: 'terminal' }));
            return new Promise(resolve => { releaseSend = () => resolve({ success: true }); });
        }
        if (frame.type === TYPES.attach || frame.type === TYPES.detach) queueMicrotask(() => f.outcome(frame));
        return { success: true };
    } });
    const c = f.connect(); await c.ready;
    c.post(c.frame(TYPES.request, 'callback-held', { timeoutMs: 100, payload: {} }));
    await until(() => releaseSend); await tick(); assert.equal(f.broker.pendingCount, 1); assert.equal(c.replies.length, 0);
    releaseSend(); await until(() => c.replies.length === 1); assert.equal(c.replies[0].ok, true);
    // A second operation does not complete merely because its deadline fired.
    const g = fixture(t), d = g.connect(); await d.ready;
    const held = d.frame(TYPES.request, 'deadline-held', { timeoutMs: 100, payload: {} }); d.post(held);
    await until(() => g.sent.some(frame => frame.type === TYPES.cancel));
    assert.equal(g.broker.pendingCount, 1); assert.equal(d.replies.length, 0);
    g.outcome(held, {}); await until(() => d.replies.length === 1); assert.equal(d.replies[0].errorCode, 'NODE_CONTROL_CANCELLED');
});

test('an actual send failure result triggers acknowledged connection cleanup rather than dispatch success', async t => {
    const f = fixture(t), c = f.connect(); await c.ready; f.failSend(true);
    c.post(c.frame(TYPES.request, 'send-failed', { timeoutMs: 1000, payload: {} }));
    await until(() => f.broker.connections.size === 0);
    assert.equal(f.sent.some(x => x.type === TYPES.detach), true); assert.equal(c.replies[0].ok, false);
    assert.equal(f.broker.pendingBytes, 0);
});

test('revocation during held attach cannot hand a late port to the View', async t => {
    const f = fixture(t); f.holdAttach(); const c = f.connect();
    const rejected = assert.rejects(c.ready, /Owner ended/); await until(() => f.sent.length === 1);
    f.revoke(); const closing = c.close(); f.outcome(f.sent[0]); await closing; await rejected;
    assert.equal(f.target.delivery, undefined); assert.equal(f.broker.connections.size, 0);
});

test('real Runtime exit terminates only its owned transport; unrelated message routing is retained', async t => {
    const f = fixture(t), c = f.connect(); await c.ready;
    c.post(c.frame(TYPES.request, 'held', { timeoutMs: 1000, payload: {} })); await until(() => f.broker.pendingCount === 1);
    f.exit(); await until(() => f.broker.connections.size === 0); assert.equal(f.broker.pendingCount, 0);
    assert.equal(f.broker.handle('stream', { type: 'aily-subapp-host-provider.catalog' }), false);
    assert.equal(f.broker.handle('stream', { type: 'aily-subapp-node-control.unknown' }), true);
});

test('the real public renderer IPC handler cannot manufacture private Node control lifecycle frames', async () => {
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(require('node:path').join(__dirname, 'window.js'), 'utf8');
    const start = source.indexOf('ipcMain.handle("child-tool-session-message-send"'), end = source.indexOf('ipcMain.handle("child-tool-session-controller-bind"', start);
    let handler, sends = 0;
    vm.runInNewContext(source.slice(start, end), { ipcMain: { handle(_name, fn) { handler = fn; } },
        sanitizeChildToolId: value => value, childToolSessions: new Map([['fixture', {}]]),
        authorizeChildToolMessagePortSend: () => ({ success: true, streamId: 'registered' }),
        sendCmdProcessMessage: async () => { sends++; return { success: true }; } });
    for (const type of [...Object.values(TYPES), ...Object.values(require('./subapp-browser-owner-bridge').TYPES)]) {
        const outcome = await handler({ sender: { id: 1 } }, { toolId: 'fixture', message: { type, context: { actor: 'view', sessionId: 'forged' } } });
        assert.equal(outcome.success, false); assert.equal(outcome.reason, 'reserved-message-type');
    }
    assert.equal(sends, 0);
    assert.equal((await handler({ sender: { id: 1 } }, { toolId: 'fixture', message: { type: 'aily-subapp-host-provider.negotiation.response' } })).success, true);
    assert.equal(sends, 1);
});

test('the sandbox preload only transfers one exact Main-issued port envelope without an invoke bridge', () => {
    const fs = require('node:fs'), vm = require('node:vm'), handlers = new Map(), deliveries = [];
    vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, 'subapp-browser-execution-preload.js'), 'utf8'), {
        require: id => { assert.equal(id, 'electron'); return { ipcRenderer: { on: (name, handler) => handlers.set(name, handler) } }; },
        location: { origin: 'http://127.0.0.1:49152' }, window: { postMessage: (...args) => deliveries.push(args) },
    });
    const envelope = { protocol: PROTOCOL, version: 1, role: 'view', runtimeId: randomUUID(), connectionId: randomUUID(), packageName: '@fixture/installed', packageVersion: '1.0.0' };
    const deliver = handlers.get('subapp-node-control-port'), port = {};
    deliver({ ports: [port] }, { ...envelope, context: { owner: 'not-public' } });
    deliver({ ports: [port] }, { ...envelope, version: 2 }); deliver({ ports: [port, {}] }, envelope);
    assert.equal(deliveries.length, 0);
    deliver({ ports: [port] }, envelope);
    assert.equal(deliveries.length, 1); assert.equal(deliveries[0][1], 'http://127.0.0.1:49152'); assert.equal(deliveries[0][2][0], port);
});

test('real forked Node IPC drains request/cancel/detach and uses the production registered ingress function', { timeout: 5000 }, async t => {
    const child = fork(require('node:path').join(__dirname, 'test/fixtures/subapp-node-control-runtime.cjs'), [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    // Node 24 on Windows can emit exit and both stdio close events without a
    // ChildProcess close event after IPC disconnect. Join the actual resources.
    const exited = once(child, 'exit'), streamsClosed = Promise.all([once(child.stdout, 'close'), once(child.stderr, 'close')]);
    let stderr = ''; child.stdout.resume(); child.stderr.on('data', bytes => { stderr += bytes; });
    t.after(async () => { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill(); await exited; await streamsClosed; });
    const f = fixture(t, { timeoutMs: 1000, send: (_stream, frame) => new Promise(resolve => child.send(normalizeProcessMessage(frame, 1024 * 1024).message,
        error => resolve({ success: !error }))) });
    // Use the exact production window.js router, without executing Electron UI
    // initialization or substituting its registered child/broker dispatch.
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(require('node:path').join(__dirname, 'window.js'), 'utf8');
    const start = source.indexOf('function routeChildToolProcessMessage('), end = source.indexOf('function bufferPendingChildToolProcessMessage(', start);
    const streams = new Map(), delivered = [], methods = new Map(), leases = require('./child-tool-session-leases');
    const portInfo = stream => stream === f.lease.runtimeId && child.connected ? { maxMessageBytes: 1024 * 1024 } : null;
    const context = { childToolSessions: streams, getCmdProcessMessagePortInfo: portInfo, nodeControlBroker: f.broker,
        browserOwnerBridge: new (require('./subapp-browser-owner-bridge').SubappBrowserOwnerBridge)({ send: async () => ({ success: true }), resolveRuntime: () => null }),
        browserProcessBroker: { handle: () => false }, ailyHostAuthRelay: null, deliverChildToolProcessMessage: (...args) => delivered.push(args), bufferPendingChildToolProcessMessage() {} };
    Object.assign(context, { ipcMain: { handle: (name, handler) => methods.set(name, handler) },
        sanitizeChildToolId: value => value, trackChildToolSessionOwner: sender => sender.id,
        classifyChildToolSessionRegistration: leases.classifyRegistration, isChildToolSessionAlive: session => !!session && !session.exit,
        acquireChildToolOwner: leases.acquireOwner, childToolOwnerCount: leases.ownerCount, cloneChildToolSession: session => session,
        notifyChildToolSessionStateChanged() {}, flushPendingChildToolProcessMessages() {}, console: { info() {} } });
    const registerStart = source.indexOf('ipcMain.handle("child-tool-session-register"'), registerEnd = source.indexOf('ipcMain.handle("child-tool-session-message-send"', registerStart);
    vm.runInNewContext(source.slice(registerStart, registerEnd), context);
    const registered = await methods.get('child-tool-session-register')({ sender: { id: f.lease.ownerId } },
        { toolId: 'fixture', streamId: f.lease.runtimeId, leaseId: f.lease.leaseId, hostInfo: { pid: child.pid } });
    assert.equal(registered.success, true); assert.equal(registered.session.hostInfo.pid, child.pid);
    assert.equal(leases.hasOwner(registered.session, f.lease.ownerId, f.lease.leaseId), true);
    f.broker.resolveRuntime = stream => [...streams.values()].find(session => session.streamId === stream && portInfo(stream)) || null;
    vm.runInNewContext(source.slice(start, end), context);
    child.on('message', message => context.routeChildToolProcessMessage({ streamId: f.lease.runtimeId, message }));
    const c = f.connect(); await c.ready;
    c.post(c.frame(TYPES.request, 'real-echo', { timeoutMs: 1000, payload: { value: 42 } }));
    await until(() => c.replies.length === 1); assert.deepEqual(c.replies[0].result, { value: 42 });
    c.post(c.frame(TYPES.request, 'real-held', { timeoutMs: 1000, payload: { hold: true } })); await until(() => f.broker.pendingCount === 1);
    c.post(c.frame(TYPES.cancel, 'real-held')); await tick(); assert.equal(f.broker.pendingCount, 1);
    await c.close(); assert.equal(f.broker.pendingCount, 0); assert.equal(f.broker.connections.size, 0); assert.deepEqual(delivered, []);
    child.disconnect(); const [code] = await exited; await streamsClosed;
    assert.equal(code, 0); assert.equal(child.stdout.closed, true); assert.equal(child.stderr.closed, true); assert.equal(stderr, '');
    t.diagnostic(JSON.stringify({ registeredChildPid: child.pid, exitCode: code, stdoutClosed: child.stdout.closed, stderrClosed: child.stderr.closed,
        connections: f.broker.connections.size, pending: f.broker.pendingCount, pendingBytes: f.broker.pendingBytes }));
});
