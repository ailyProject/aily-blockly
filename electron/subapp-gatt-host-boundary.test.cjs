'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMainGattHostBoundary } = require('./subapp-gatt-host-boundary');
const { createMainGattNativeChooser } = require('./subapp-gatt-native-chooser');

// Only tests accept an explicit built shared module. Normal Main uses the
// verified installed package loader and has no source-path fallback.
let api;
test.before(() => {
    if (!process.env.AILY_GATT_TEST_MODULE) throw Error('Actual built GATT provider module is required for this composition test');
    api = require(process.env.AILY_GATT_TEST_MODULE);
});
function context() {
    const scope = { worldId: 'world', nodeId: 'node', clockDomainId: 'clock' };
    return { schemaVersion: 1, kind: 'aily-session-bluetooth-context', sessionId: 'session', sceneRevision: 'a'.repeat(64),
        runtimeGeneration: 1, runtimeTimeEpoch: 2, sessionState: 'running', unavailableReason: null,
        bluetooth: { descriptor: { schemaVersion: 1, kind: 'aily-bluetooth-controller-port', scope,
            profileId: 'runtime-profile', executionId: 'execution', framing: 'hci-h4-v1', controllerModes: ['le'],
            aclDataPacketBytes: 255, limits: { maxBufferedPackets: 16, maxBufferedBytes: 4096,
                maxReadPackets: 4, maxReadBytes: 1024, maxPendingWrites: 4 } },
        snapshot: { schemaVersion: 1, kind: 'aily-bluetooth-controller-snapshot', scope, generation: 1,
            timeEpoch: 2, connectionEpoch: 1, state: 'open', readSequence: 0, writeSequence: 0,
            readBufferedPackets: 0, readBufferedBytes: 0, writeQueueCreditPackets: 4,
            writeQueueCreditBytes: 4096, pendingWrites: 0, droppedPackets: 0, droppedBytes: 0 } } };
}
function descriptor() {
    return { schemaVersion: 1, kind: 'aily-host-gatt-backend', backendId: 'mac-gatt', capability: 'bluetooth.gatt',
        executionLocation: 'user-device', resourceLocation: 'user-device', permissionAuthority: 'local-user',
        availability: 'available', permissionState: 'prompt', unavailableReason: null, roles: ['central'],
        operations: ['discover', 'read', 'write-with-response', 'notify'], rawHci: false, classicSpp: false,
        limits: { maxLeases: 1, maxPendingRequests: 2, maxQueuedRecords: 4, maxQueuedBytes: 64,
            maxReadRecords: 2, maxReadBytes: 32, maxPayloadBytes: 16, idleTimeoutMs: 30000 } };
}
function fixture(t, options = {}) {
    const sender = { id: 7, mainFrame: {}, isDestroyed: () => false };
    const main = { webContents: sender, isDestroyed: () => false }, event = { sender, senderFrame: sender.mainFrame };
    const h = { actual: context(), calls: [], binding: null, current: true, ownerRelease: null, receive: null };
    const selected = Object.freeze({ peerId: 'selected-peer' });
    const backend = { async scan() {
        h.calls.push('scan');
        return { ready: Promise.resolve(), async close() { h.calls.push('scan-close'); },
            snapshot: () => ({ state: 'stopped', candidates: [{ candidateId: 'candidate', label: 'Controlled peer', rssi: -30 }] }),
            select(id) { assert.equal(id, 'candidate'); return selected; } };
    }, releaseSelection(value) { assert.equal(value, selected); h.calls.push('abandon-selection'); }, createDriver(value) {
        assert.equal(value, selected); h.calls.push('driver');
        return { async open(id) { assert.equal(id, selected.peerId); h.calls.push('open');
            return { async discover() { return [{ serviceId: 'service', uuid: '0000180f-0000-1000-8000-00805f9b34fb', characteristics: [
                { characteristicId: 'char', uuid: '00002a19-0000-1000-8000-00805f9b34fb', properties: ['read', 'write-with-response', 'notify'] }] }]; },
            async read() { return Uint8Array.of(0, 255, 3); },
            async write(_id, _mode, bytes) { h.calls.push([...bytes]); return { acceptedBytes: bytes.length, completion: 'peer-acknowledged' }; },
            async subscribe(_id, _mode, receive) { h.receive = receive; return { async close() { h.calls.push('unsubscribe'); } }; },
            async close() { h.calls.push('disconnect'); if (h.failPeerClose) throw Error('Original peer disconnect unconfirmed'); } };
        }, async dispose() { h.calls.push('driver-dispose'); } };
    } };
    let dialogs = 0, sequence = 0;
    const choosePeer = createMainGattNativeChooser({ backend, getMainWindow: () => main, dialog: { async showMessageBox() {
        dialogs++; options.dialog?.(h, dialogs); return { response: options.cancel ? 0 : 1 };
    } } });
    const provider = api.createNodeHostGattProvider({ hostInstanceId: 'host', descriptor: descriptor(), operationTimeoutMs: 200, cleanupTimeoutMs: 100 });
    const boundary = createMainGattHostBoundary({ protocol: api, getMainWindow: () => main,
        requireController(id, authority) { assert.equal(id, 7); assert.equal(authority.toolId, 'simulator'); if (!h.current) throw Error('controller ended'); },
        choosePeer: options.forgedChooser ? async () => ({ outcome: 'selected', peerId: 'forged' }) : choosePeer,
        async resolveOriginalOwnerGattPort(input) {
            h.calls.push('resolve');
            h.binding = provider.bind({ authority: input.authority, requireCurrentAuthority: input.requireCurrentController,
                trustedBluetoothContext: async () => structuredClone(h.actual),
                choosePeer: (value, signal) => input.choosePeer(value, signal, input.requireCurrentController),
                registerOwnerRelease(retire) { h.ownerRelease = retire; return () => { h.ownerRelease = null; }; } });
            return { request: h.binding.request, close: h.binding.close };
        } });
    const q = (operation, extra = {}) => ({ schemaVersion: 1, kind: 'aily-host-gatt-provider-request', requestId: 'outer-' + (++sequence), requestSequence: sequence, operation, ...extra });
    const envelope = (request, producerId = h.producerId) => ({ action: 'request', toolId: 'simulator', streamId: 'stream', bindingId: 'binding', producerId, request });
    const bindingState = () => boundary.invoke(event, { action: 'binding-state', toolId: 'simulator', streamId: 'stream', bindingId: 'binding' });
    const send = async (operation, extra) => {
        if (!h.producerId) h.producerId = (await bindingState()).producerId;
        const value = await boundary.invoke(event, envelope(q(operation, extra)));
        if (value.kind === 'aily-host-gatt-bound-provider-result') {
            assert.equal(value.producerId, h.producerId); return value.result;
        }
        return value;
    };
    t.after(async () => { h.current = true; await boundary.dispose(); await provider.dispose(); });
    return { h, boundary, provider, send, q, envelope, event, bindingState, dialogs: () => dialogs };
}

test('GATT Main boundary and actual shared provider select one opaque peer without opening it', async t => {
    const f = fixture(t); const catalog = await f.send('catalog'); assert.equal(catalog.catalog.backends[0].permissionState, 'prompt');
    const selected = await f.send('select'); assert.equal(selected.outcome, 'selected');
    assert.deepEqual(selected.grant.resourceIds, ['selected-peer']); assert.equal(selected.grant.scope.timeEpoch, 2);
    assert.equal(f.dialogs(), 2); assert(!f.h.calls.includes('open'));
    const backend = f.h.binding.acquireGrantBackend(selected.grant.grantId), grant = selected.grant; let n = 0;
    const execute = (command, extra) => backend.execute({ schemaVersion: 1, kind: 'aily-host-gatt-command',
        requestId: 'inner-' + (++n), requestSequence: n,
        ...Object.fromEntries(['backendId', 'grantId', 'profileId', 'executionId', 'executionLocation', 'resourceLocation', 'permissionAuthority', 'scope'].map(k => [k, grant[k]])), command, ...extra });
    const opened = await execute('open', { peerId: 'selected-peer', role: 'central' }); assert(opened.ok);
    const leaseId = opened.leaseId; assert((await execute('discover', { leaseId })).ok);
    assert.equal((await execute('read', { leaseId, characteristicId: 'char' })).dataBase64, 'AP8D');
    assert.equal((await execute('write', { leaseId, characteristicId: 'char', mode: 'with-response', dataBase64: 'CQD/', dataByteLength: 3 })).completion, 'peer-acknowledged');
    assert(f.h.calls.some(x => Array.isArray(x) && x.join() === '9,0,255'));
    await backend.dispose(); assert(f.h.calls.includes('disconnect')); assert(f.h.calls.includes('driver-dispose'));
});

test('forged chooser and foreign sender cannot acquire a provider or scan', async t => {
    const f = fixture(t, { forgedChooser: true }); assert.deepEqual((await f.send('catalog')).catalog.backends, []);
    f.h.producerId = (await f.bindingState()).producerId;
    assert.equal((await f.send('select')).errorCode, 'unavailable'); assert.deepEqual(f.h.calls, []);
    const other = { ...f.event, senderFrame: {} };
    assert.equal((await f.boundary.invoke(other, f.envelope(f.q('select')))).errorCode, 'permission-denied');
    assert.deepEqual(f.h.calls, []);
});

test('a browser cannot choose a device, mode, Core context or permission in select', async t => {
    const f = fixture(t);
    for (const extra of [{ peerId: 'foreign' }, { scope: {} }, { mode: 'peripheral' }, { permission: 'granted' }])
        assert.equal((await f.send('select', extra)).errorCode, 'invalid-input');
    assert.deepEqual(f.h.calls, []); assert.equal(f.dialogs(), 0);
});

test('Core epoch change during native device consent is rejected before driver acquisition', async t => {
    const f = fixture(t, { dialog(h, n) { if (n === 2) { h.actual.runtimeTimeEpoch = 3; h.actual.bluetooth.snapshot.timeEpoch = 3; } } });
    const result = await f.send('select'); assert.equal(result.errorCode, 'stale-scope');
    assert(!f.h.calls.includes('driver')); assert.equal(f.provider.snapshot().ownedDrivers, 0);
});

test('controller retirement cannot block trusted exact-original GATT cleanup', async t => {
    const f = fixture(t); assert.equal((await f.send('select')).outcome, 'selected');
    f.h.current = false;
    await f.boundary.closeBinding({ senderId: 7, toolId: 'simulator', streamId: 'stream', bindingId: 'binding' });
    assert(f.h.calls.includes('driver-dispose')); assert.equal(f.provider.snapshot().ownedDrivers, 0);
    assert.equal(f.boundary.snapshot().bindings, 0);
});

test('Main producer renewal fences old requests and exact old close cannot retire its successor', async t => {
    const f = fixture(t); await f.send('catalog'); const old = await f.bindingState();
    assert.equal(old.producerId, f.h.producerId);
    const closed = await f.boundary.invoke(f.event, { action: 'close', toolId: 'simulator', streamId: 'stream', bindingId: 'binding', producerId: old.producerId });
    assert.equal(closed.closed, true);
    const next = await f.bindingState(); assert.notEqual(next.producerId, old.producerId); assert.equal(next.revision, old.revision + 1);
    const before = f.h.calls.length;
    const stale = await f.boundary.invoke(f.event, f.envelope(f.q('select'), old.producerId));
    assert.equal(stale.producerId, old.producerId); assert.equal(stale.result.errorCode, 'stale-scope'); assert.equal(f.h.calls.length, before);
    await f.boundary.invoke(f.event, { action: 'close', toolId: 'simulator', streamId: 'stream', bindingId: 'binding', producerId: old.producerId });
    assert.deepEqual(await f.bindingState(), next);
});

test('fenced exact producer can return a real release receipt after failed close without admitting old business', async t => {
    const f = fixture(t), selected = await f.send('select'), grant = selected.grant;
    const backend = f.h.binding.acquireGrantBackend(grant.grantId);
    const opened = await backend.execute({ schemaVersion: 1, kind: 'aily-host-gatt-command', requestId: 'open-original', requestSequence: 1,
        ...Object.fromEntries(['backendId', 'grantId', 'profileId', 'executionId', 'executionLocation', 'resourceLocation', 'permissionAuthority', 'scope'].map(k => [k, grant[k]])),
        command: 'open', peerId: 'selected-peer', role: 'central' });
    assert(opened.ok); const old = await f.bindingState(); f.h.failPeerClose = true;
    const failed = await f.boundary.invoke(f.event, { action: 'close', toolId: 'simulator', streamId: 'stream', bindingId: 'binding', producerId: old.producerId });
    assert.equal(failed.errorCode, 'cleanup-unconfirmed');
    assert.equal((await f.bindingState()).producerId, old.producerId);
    f.h.current = false; f.h.failPeerClose = false;
    const release = await f.send('release');
    assert.equal(release.ok, true); assert.equal(release.operation, 'release'); assert.equal(release.state, 'released');
    assert(f.h.calls.includes('disconnect')); f.h.current = true;
    const next = await f.bindingState(); assert.notEqual(next.producerId, old.producerId);
});
