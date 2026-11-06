'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { SubappBrowserProcessBroker } = require('./subapp-browser-process-broker');
const { SubappBrowserExecutionHost } = require('./subapp-browser-execution-host');
const { acquireOwner, ownerKey } = require('./child-tool-session-leases');
function fixture() {
    const host = new SubappBrowserExecutionHost(), lease = { runtimeId: 'runtime.1', executionId: randomUUID(), ownerId: 7, leaseId: 'original-owner' };
    const ownerHandle = randomUUID(), connectionId = randomUUID(), key = ownerKey(lease.ownerId, lease.leaseId);
    const state = { runtimeId: lease.runtimeId, executionId: lease.executionId, owners: new Map(), bindings: new Map(), connections: new Map(), ownerHandles: new Map(), retiring: new Set() };
    acquireOwner(state, lease.ownerId, lease.leaseId);
    state.bindings.set(key, { node: { nodeBound: true, bindingId: connectionId, owner: { sessionId: lease.leaseId } } });
    const connection = { connectionId, key }; state.connections.set(connectionId, connection); state.ownerHandles.set(key, ownerHandle); host.runtimes.set(lease.runtimeId, state);
    const broker = new SubappBrowserProcessBroker({ host }); let current = true;
    const guard = () => { if (!current) throw Error('Original process owner ended'); };
    const record = { key: JSON.stringify([lease.runtimeId, lease.executionId, lease.ownerId, lease.leaseId]), lease, guard, toolId: 'simulator', connection };
    broker.owners.set(record.key, record); broker.connections.set(connectionId, record);
    const resolve = () => broker.resolveNetworkOwner({ runtimeId: lease.runtimeId, ownerId: 7, toolId: 'simulator' });
    return { host, lease, ownerHandle, connectionId, state, key, broker, record, resolve, end: () => { current = false; } };
}
test('workspace binding alone cannot produce an original registered network owner', () => {
    const f = fixture(); f.broker.owners.clear(); assert.equal(f.resolve(), null);
});
test('only one exact existing acknowledged process owner can be used; foreign or ambiguous is unavailable', () => {
    const f = fixture(); assert(f.resolve()); assert.equal(f.broker.resolveNetworkOwner({ runtimeId: f.lease.runtimeId, ownerId: 8, toolId: 'simulator' }), null);
    f.broker.owners.set('another', { ...f.record, key: 'another' }); assert.equal(f.resolve(), null);
});
test('pending, retired, replaced or failed actual process connection is not an authority', () => {
    for (const mutate of [f => { f.record.retiring = true; }, f => { f.record.admissionFailed = true; }, f => { f.broker.connections.clear(); }, f => f.end()]) { const f = fixture(); mutate(f); assert.equal(f.resolve(), null); }
});
test('normal private owner control requires actual Node ACK, same original lease and same connection', () => {
    for (const mutate of [f => { f.state.bindings.get(f.key).node.nodeBound = false; }, f => { f.state.bindings.get(f.key).node.bindingId = randomUUID(); }, f => { f.state.bindings.get(f.key).node.owner.sessionId = 'foreign'; }]) { const f = fixture(), original = f.resolve(); mutate(f); assert.throws(() => f.host.createNetworkOwnerControl(original)); }
});
test('private query and attach use captured ownerhandle/connection; no selector is accepted from a browser', async () => {
    const f = fixture(), calls = [], context = { actualSnapshot: true }; f.host.request = async (...args) => { calls.push(args); return { diagnostics: {}, networkContext: context }; };
    const control = f.host.createNetworkOwnerControl(f.resolve()); assert.equal(await control.query(new AbortController().signal), context);
    assert.equal(calls[0][1], 'network-context'); assert.deepEqual(calls[0][2], { connectionId: f.connectionId, ownerHandle: f.ownerHandle });
    const port = { fakeTransferOnly: true }, attach = { sessionId: 'owned-session', descriptor: { from: 'actual' }, grant: { from: 'Main' }, routes: [{ endpointId: 'fixed' }] };
    await control.attach(attach, port); assert.equal(calls[1][1], 'network-host-attach'); assert.deepEqual(calls[1][2], { connectionId: f.connectionId, ownerHandle: f.ownerHandle, ...attach }); assert.deepEqual(calls[1][3], [port]);
    await control.detach('owned-session', 'grant-1'); assert.equal(calls[2][1], 'network-host-detach'); assert.deepEqual(calls[2][2], { connectionId: f.connectionId, ownerHandle: f.ownerHandle, sessionId: 'owned-session', grantId: 'grant-1' });
});
test('asynchronous private result is rejected after original record retirement or binding replacement', async () => {
    for (const mutate of [f => f.end(), f => f.broker.owners.delete(f.record.key), f => { f.state.bindings.set(f.key, { ...f.state.bindings.get(f.key) }); }]) {
        const f = fixture(); let resolve; f.host.request = () => new Promise(done => { resolve = done; }); const control = f.host.createNetworkOwnerControl(f.resolve());
        const pending = control.query(new AbortController().signal); mutate(f); resolve({ networkContext: { freshButForeignNow: true } }); await assert.rejects(pending);
    }
});
test('missing installed private query field and already-aborted query fail without fallback', async () => {
    const f = fixture(); let calls = 0; f.host.request = async () => { calls++; return {}; }; const control = f.host.createNetworkOwnerControl(f.resolve());
    await assert.rejects(control.query(new AbortController().signal), /unavailable/); const abort = new AbortController(); abort.abort(); await assert.rejects(control.query(abort.signal)); assert.equal(calls, 1);
});
test('original releasing owner can detach only its captured binding before Worker/Node release acknowledgement', async () => {
    const f = fixture(), order = [], binding = f.state.bindings.get(f.key);
    f.state.ready = true; f.state.window = { isDestroyed: () => false };
    binding.bridge = { bind: async () => order.push('node-bind-joined'), released: async () => order.push('node-release-joined') };
    f.host.request = async (_state, type) => { order.push(type); return {}; };
    const control = f.host.createNetworkOwnerControl(f.resolve());
    control.registerOwnerRelease(() => control.detach('owned-session', 'grant-1'));
    f.state.retiring.add(f.key); f.end();
    await assert.rejects(control.query(new AbortController().signal));
    await f.host.confirmOwnerRelease(f.state, f.key, binding);
    assert.deepEqual(order, ['network-host-detach', 'owner-release', 'node-bind-joined', 'node-release-joined']);
    assert.equal(binding.networkRetireCallbacks.size, 0);
});
test('cleanup lane rejects a replacement captured identity and keeps failed callback for explicit retry', async () => {
    const f = fixture(), binding = f.state.bindings.get(f.key); let fail = true, calls = 0, workerReleases = 0;
    f.state.ready = true; f.state.window = { isDestroyed: () => false }; binding.bridge = { bind: async () => {}, released: async () => {} };
    f.host.request = async (_state, type) => { if (type === 'owner-release') workerReleases++; return {}; };
    const control = f.host.createNetworkOwnerControl(f.resolve());
    control.registerOwnerRelease(async () => { calls++; if (fail) throw Error('actual backend close not confirmed'); });
    f.state.retiring.add(f.key); f.end();
    await assert.rejects(f.host.confirmOwnerRelease(f.state, f.key, binding), /network owner cleanup/); assert.equal(workerReleases, 0); assert.equal(binding.networkRetireCallbacks.size, 1);
    fail = false; await f.host.confirmOwnerRelease(f.state, f.key, binding); assert.equal(calls, 2); assert.equal(workerReleases, 1);
    f.state.ownerHandles.set(f.key, randomUUID()); await assert.rejects(control.detach('owned-session', 'grant-1')); assert.equal(workerReleases, 1);
});
