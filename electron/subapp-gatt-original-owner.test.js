'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { SubappBrowserExecutionHost } = require('./subapp-browser-execution-host');
const { acquireOwner, ownerKey } = require('./child-tool-session-leases');

function fixture() {
    const host = new SubappBrowserExecutionHost();
    const lease = { runtimeId: 'runtime.1', executionId: randomUUID(), ownerId: 7, leaseId: 'original-owner' };
    const ownerHandle = randomUUID(), connectionId = randomUUID(), key = ownerKey(lease.ownerId, lease.leaseId);
    const state = { runtimeId: lease.runtimeId, executionId: lease.executionId, owners: new Map(), bindings: new Map(),
        connections: new Map(), ownerHandles: new Map(), retiring: new Set() };
    acquireOwner(state, lease.ownerId, lease.leaseId);
    const binding = { node: { nodeBound: true, bindingId: connectionId, owner: { sessionId: lease.leaseId } } };
    state.bindings.set(key, binding); state.connections.set(connectionId, { connectionId, key });
    state.ownerHandles.set(key, ownerHandle); host.runtimes.set(lease.runtimeId, state);
    let valid = true;
    const current = () => { if (!valid) throw Error('original owner ended'); };
    const original = { lease, connectionId, guard: current, assertCurrent: current };
    return { host, state, binding, key, original, connectionId, ownerHandle, end: () => { valid = false; } };
}

test('Bluetooth private controls require the actual Node ACK and use only Bluetooth wire operations', async () => {
    const f = fixture(), calls = [], context = { actualCoreSnapshot: true };
    f.host.request = async (...args) => { calls.push(args); return { bluetoothContext: context }; };
    const control = f.host.createBluetoothOwnerControl(f.original);
    assert.deepEqual(Object.keys(control).sort(), ['attach', 'detach', 'query', 'registerOwnerRelease', 'requireCurrent']);
    assert.equal(await control.query(new AbortController().signal), context);
    assert.equal(calls[0][1], 'bluetooth-context');
    assert.deepEqual(calls[0][2], { connectionId: f.connectionId, ownerHandle: f.ownerHandle });
    const grant = { grantId: 'original-grant' }, descriptor = { backendId: 'original-backend' }, port = {};
    await control.attach({ sessionId: 'session', descriptor, grant }, port);
    assert.equal(calls[1][1], 'gatt-host-attach');
    assert.deepEqual(calls[1][2], { connectionId: f.connectionId, ownerHandle: f.ownerHandle, sessionId: 'session', descriptor, grant });
    assert.deepEqual(calls[1][3], [port]);
    await control.detach('session', grant.grantId); assert.equal(calls[2][1], 'gatt-host-detach');
    f.binding.node.nodeBound = false; assert.throws(() => f.host.createBluetoothOwnerControl(f.original));
});

test('missing private Bluetooth field has no fallback to a network snapshot', async () => {
    const f = fixture(); f.host.request = async () => ({ networkContext: { unrelated: true } });
    await assert.rejects(f.host.createBluetoothOwnerControl(f.original).query(), /Bluetooth context API is unavailable/);
});

test('Bluetooth query revalidates the exact original binding after asynchronous response', async () => {
    for (const change of [f => f.end(), f => f.state.bindings.set(f.key, { ...f.binding }),
        f => f.state.ownerHandles.set(f.key, randomUUID())]) {
        const f = fixture(); let respond; f.host.request = () => new Promise(resolve => { respond = resolve; });
        const pending = f.host.createBluetoothOwnerControl(f.original).query(); change(f);
        respond({ bluetoothContext: { stale: true } }); await assert.rejects(pending);
    }
});

test('Bluetooth cleanup joins the original process-owner barrier; failed cleanup remains before Worker release', async () => {
    const f = fixture(), order = []; let fail = true;
    f.state.ready = true; f.state.window = { isDestroyed: () => false };
    f.binding.bridge = { bind: async () => order.push('node-bound'), released: async () => order.push('node-released') };
    f.host.request = async (_state, type) => { order.push(type); return {}; };
    const control = f.host.createBluetoothOwnerControl(f.original);
    control.registerOwnerRelease(async () => { order.push('gatt-close'); if (fail) throw Error('disconnect unconfirmed'); });
    f.state.retiring.add(f.key); f.end();
    await assert.rejects(f.host.confirmOwnerRelease(f.state, f.key, f.binding));
    assert.deepEqual(order, ['gatt-close']); assert.equal(f.binding.networkRetireCallbacks.size, 1);
    fail = false; await f.host.confirmOwnerRelease(f.state, f.key, f.binding);
    assert.deepEqual(order, ['gatt-close', 'gatt-close', 'owner-release', 'node-bound', 'node-released']);
    assert.equal(f.binding.networkRetireCallbacks.size, 0);
});
