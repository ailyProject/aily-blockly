'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { SubappNodeControlBroker, TYPES, PROTOCOL } = require('./subapp-node-control-broker');

class Port extends EventEmitter {
    postMessage(data) {
        if (this.closed) throw new Error('Port closed');
        queueMicrotask(() => { if (!this.peer.closed) this.peer.emit('message', { data }); });
    }
    start() {}
    close() { this.closed = true; }
}
class Channel {
    constructor() {
        this.port1 = new Port(); this.port2 = new Port();
        this.port1.peer = this.port2; this.port2.peer = this.port1;
    }
}
class Target extends EventEmitter {
    isDestroyed() { return false; }
    postMessage(_channel, _data, ports) { this.port = ports[0]; }
}

async function fixture(t) {
    const sent = [], replies = [], target = new Target();
    const streamId = 'selection-budget-runtime', runtimeId = randomUUID();
    const lease = { runtimeId: streamId, executionId: runtimeId, leaseId: randomUUID() };
    const cleanup = new Set();
    const guard = () => {};
    Object.assign(guard, { runtime: { streamId }, ownerSessionId: lease.leaseId,
        attachCleanup(fn) { cleanup.add(fn); return () => cleanup.delete(fn); } });
    const broker = new SubappNodeControlBroker({ MessageChannelMain: Channel,
        timeoutMs: 100, cancelGraceMs: 50,
        resolveRuntime: () => ({ messagePort: { maxMessageBytes: 1024 * 1024 } }),
        send: async (stream, frame) => {
            assert.equal(stream, streamId); sent.push(frame);
            const type = frame.type === TYPES.attach ? TYPES.attached
                : frame.type === TYPES.detach ? TYPES.detached : TYPES.result;
            queueMicrotask(() => broker.handle(streamId, { type, version: 1, runtimeId,
                connectionId: frame.connectionId, requestId: frame.requestId, ok: true,
                ...(frame.type === TYPES.request ? { result: { forwarded: frame.payload } } : {}) }));
            return { success: true };
        } });
    const opened = broker.connectView({ lease, guard, target, assertCurrent: guard,
        source: { protocol: PROTOCOL, packageName: '@fixture/installed', version: '1.0.0', maxMessageBytes: 1024 * 1024 } });
    await opened.ready;
    target.port.on('message', ({ data }) => replies.push(data));
    t.after(async () => {
        await opened.close();
        assert.equal(broker.connections.size, 0); assert.equal(cleanup.size, 0);
        assert.equal(broker.pendingCount, 0); assert.equal(broker.pendingBytes, 0);
    });
    return { sent, replies, async request(payload, timeoutMs) {
        const requestId = randomUUID();
        target.port.postMessage({ type: TYPES.request, version: 1, runtimeId,
            connectionId: opened.connectionId, requestId, timeoutMs, payload });
        for (let i = 0; i < 100; i++) {
            const response = replies.find(frame => frame.requestId === requestId);
            if (response) return { response, forwarded: sent.find(frame => frame.type === TYPES.request && frame.requestId === requestId) };
            await new Promise(resolve => setImmediate(resolve));
        }
        throw new Error('Finite selection-budget fixture did not settle');
    } };
}

const selection = operation => ({ schemaVersion: 1, kind: 'aily-project-scene-shell-request',
    operation, launchId: `launch-v1-${'a'.repeat(64)}`, action: 'select' });

test('the exact local-gatt select forwards the original 60000 ms request and actual Node result', async t => {
    const f = await fixture(t), payload = selection('local-gatt');
    const { response, forwarded } = await f.request(payload, 60000);
    assert.equal(response.ok, true);
    assert.equal(forwarded.timeoutMs, 60000); assert.deepEqual(forwarded.payload, payload);
    assert.deepEqual(response.result, { forwarded: payload });
});

test('the existing exact local-network select retains its 60000 ms budget', async t => {
    const f = await fixture(t), payload = selection('local-network');
    const { response, forwarded } = await f.request(payload, 60000);
    assert.equal(response.ok, true); assert.equal(forwarded.timeoutMs, 60000);
    assert.deepEqual(response.result, { forwarded: payload });
});

test('neither local selection can exceed 60000 ms or forward a rejected request', async t => {
    const f = await fixture(t);
    for (const operation of ['local-gatt', 'local-network']) {
        const { response, forwarded } = await f.request(selection(operation), 60001);
        assert.equal(response.ok, false); assert.equal(response.errorCode, 'NODE_CONTROL_INVALID_REQUEST');
        assert.equal(response.error, 'Invalid Node control request'); assert.equal(forwarded, undefined);
    }
});

test('the extended budget requires the exact selection shape and does not extend other operations', async t => {
    const f = await fixture(t), valid = selection('local-gatt');
    const rejected = [
        ...['status', 'read', 'release'].map(action => ({ ...valid, action })),
        { ...valid, operation: 'other-provider' },
        { ...valid, operation: 'local-gatt-extra' },
        { ...valid, schemaVersion: 2 },
        { ...valid, kind: 'other-shell-request' },
        { ...valid, launchId: 'launch-v1-invalid' },
        { ...valid, arbitrary: true },
    ];
    for (const payload of rejected) {
        const { response, forwarded } = await f.request(payload, 60000);
        assert.equal(response.ok, false); assert.equal(response.errorCode, 'NODE_CONTROL_INVALID_REQUEST');
        assert.equal(forwarded, undefined);
    }
    const status = { ...valid, action: 'status' };
    const { response, forwarded } = await f.request(status, 30000);
    assert.equal(response.ok, true); assert.equal(forwarded.timeoutMs, 30000);
});
