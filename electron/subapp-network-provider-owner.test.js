'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createMainNetworkProviderOwner } = require('./subapp-network-provider-owner');

const deferred = () => Promise.withResolvers();
const request = (sequence, operation = 'catalog') => ({ schemaVersion: 1,
    kind: 'aily-host-network-provider-request', requestId: `request-${sequence}`,
    requestSequence: sequence, operation });
function fixture(options = {}) {
    const calls = [], callbacks = new Set(), ports = [], grants = new Map();
    const authority = Object.freeze({ senderId: 7, toolId: 'simulator', streamId: 'original-stream', bindingId: 'workspace:1' });
    const raw = { sessionId: 'original-session', sceneRevision: 'a'.repeat(64), runtimeGeneration: 2,
        sessionState: 'running', network: { descriptor: { executionId: 'actual-execution',
            scope: { worldId: 'world', nodeId: 'mcu', clockDomainId: 'clock' } },
        snapshot: { state: 'open', generation: 3, timeEpoch: 4, connectionEpoch: 5 } } };
    const control = {
        requireCurrent() { if (options.ownerEnded) throw Error('original execution ended'); },
        async query() { calls.push('query'); if (options.query) return options.query(); return raw; },
        async attach(input) { calls.push(['attach', input.grant.grantId]); if (options.attach) await options.attach(input); },
        async detach(sessionId, grantId) { calls.push(['detach', sessionId, grantId]); if (options.detach) await options.detach(sessionId, grantId); },
        registerOwnerRelease(callback) { callbacks.add(callback); return () => { calls.push('unsubscribe'); callbacks.delete(callback); }; },
    };
    const module = {
        HOST_NETWORK_MESSAGE_PORT_DISPOSAL_SETTLEMENT_VERSION: 1,
        HOST_NETWORK_MESSAGE_PORT_TERMINAL_RESULT_SETTLEMENT_VERSION: 2,
        HOST_CONNECTIVITY_LIMITS: {}, validateHostNetworkBackendDescriptorV1: value => value,
        validateSessionNetworkContextSnapshot: value => value, validateHostConnectivityScopeV1: value => value,
        createNodeHostNetworkDriver() { return { async dispose() { calls.push('driver-dispose'); } }; },
        createNodeHostNetworkProvider() {
            return {
                bind(input) {
                    let unsubscribe;
                    const close = async () => { calls.push('binding-close');
                        if (options.bindingClose) await options.bindingClose(); unsubscribe(); };
                    unsubscribe = input.registerOwnerRelease(close);
                    return {
                        close,
                        acquireGrantBackend(grantId) {
                            const actual = { descriptor: { backendId: 'actual-backend' },
                                async execute() { throw Error('No OS operation in this fixture'); },
                                async dispose() { calls.push(['grant-dispose', grantId]); if (options.grantDispose) await options.grantDispose(); } };
                            grants.set(grantId, actual); return actual;
                        },
                        async request(value, signal) {
                            calls.push(['request', value.requestSequence, value.operation]);
                            await input.trustedCurrentContextAsync(signal);
                            if (value.operation === 'select') return { ok: true, operation: 'select', outcome: 'selected',
                                grant: { grantId: `grant-${value.requestSequence}`, scope: { sessionId: raw.sessionId }, resourceIds: ['peer'] } };
                            return { ok: true, operation: value.operation };
                        },
                    };
                },
                async dispose() { calls.push('provider-dispose'); if (options.providerDispose) await options.providerDispose(); },
            };
        },
        serveHostNetworkMessagePort({ backend }) {
            return { async close() { calls.push('server-close'); if (options.serverClose) await options.serverClose(); await backend.dispose(); } };
        },
    };
    class Port extends EventEmitter {
        constructor() { super(); this.closed = false; ports.push(this); }
        postMessage() { throw Error('No transport operation in this fixture'); }
        start() {}
        close() { this.closed = true; this.emit('close'); }
    }
    class Channel { constructor() { this.port1 = new Port(); this.port2 = new Port(); } }
    const manager = createMainNetworkProviderOwner({ configuration: { endpoints: [], routes: [{ endpointId: 'peer', tcpPort: 18080 }] },
        MessageChannelMain: Channel, loadBackend: async () => { calls.push('load'); return { module,
            async release() { calls.push('holder-release'); if (options.holderRelease) await options.holderRelease(); } }; },
        resolveOriginalOwnerNetworkControl: async () => options.noOwner ? null : control,
        onBindingRetired(value) { calls.push(['lifetime-ended', value]); },
    });
    const bind = () => manager.bind({ authority, requireCurrentController() { if (options.controllerEnded) throw Error('passive channel ended'); }, selection: {} });
    return { manager, bind, calls, callbacks, ports, grants, control, raw, authority };
}

test('an absent actual owner does not load or acquire an installed backend', async () => {
    const f = fixture({ noOwner: true }); assert.equal(await f.bind(), null);
    assert.deepEqual(f.calls, []); await f.manager.dispose();
});

test('unavailable initial Core context releases the unused package without announcing a producer', async () => {
    const f = fixture({ query: async () => null }); assert.equal(await f.bind(), null);
    assert.deepEqual(f.calls, ['load', 'query', 'provider-dispose', 'holder-release']); await f.manager.dispose();
});

test('fresh real binding refuses an already advanced producer before any provider request and renews only after retirement', async () => {
    const f = fixture(), port = await f.bind();
    await assert.rejects(port.request(request(7, 'select'), new AbortController().signal), /lifetime changed/);
    assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === 'request').length, 0);
    assert(f.calls.indexOf('holder-release') > f.calls.indexOf('provider-dispose'));
    assert.deepEqual(f.calls.at(-1), ['lifetime-ended', f.authority]);
    await port.close(); assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === 'lifetime-ended').length, 1);
    await f.manager.dispose();
});

test('same binding grant release retains the producer sequence and installed holder until terminal close', async () => {
    const f = fixture(), port = await f.bind(), signal = new AbortController().signal;
    await port.request(request(1, 'select'), signal); await port.request(request(2, 'release'), signal);
    await port.request(request(3), signal);
    assert.deepEqual(f.calls.filter(value => Array.isArray(value) && value[0] === 'request'),
        [['request', 1, 'select'], ['request', 2, 'release'], ['request', 3, 'catalog']]);
    assert.equal(f.calls.includes('holder-release'), false); assert.equal(f.ports.every(port => port.closed), true);
    assert.equal(f.calls.some(value => Array.isArray(value) && value[0] === 'lifetime-ended'), false);
    await port.close(); assert(f.calls.includes('holder-release')); await f.manager.dispose();
});

test('failed actual package-holder close keeps the lifetime fenced and publishes no new catalog identity', async () => {
    const options = { holderRelease: async () => { if (options.fail) throw Error('holder close unconfirmed'); }, fail: true };
    const f = fixture(options), port = await f.bind(); await port.request(request(1), new AbortController().signal);
    await assert.rejects(port.close(), /holder close/);
    assert.equal(f.calls.some(value => Array.isArray(value) && value[0] === 'lifetime-ended'), false);
    await assert.rejects(port.request(request(2), new AbortController().signal), /owner ended/);
    options.fail = false; await port.close();
    assert.deepEqual(f.calls.at(-1), ['lifetime-ended', f.authority]); await f.manager.dispose();
});

test('lost attach acknowledgement joins the exact original Runtime detach before server or package retirement', async () => {
    const detach = deferred(), started = deferred();
    const f = fixture({ attach: async () => { throw Error('attach ACK lost'); }, detach: async (sessionId, grantId) => {
        assert.equal(sessionId, 'original-session'); assert.equal(grantId, 'grant-1'); started.resolve(); await detach.promise;
    } });
    const port = await f.bind(); let completed = false;
    const selected = port.request(request(1, 'select'), new AbortController().signal).finally(() => { completed = true; });
    const rejected = assert.rejects(selected, /attach ACK lost/); await started.promise;
    assert.equal(completed, false); assert.equal(f.calls.includes('server-close'), false);
    assert.equal(f.ports.every(port => !port.closed), true); detach.resolve(); await rejected;
    assert(f.calls.includes('server-close')); assert.equal(f.ports.every(port => port.closed), true);
    await port.close(); await f.manager.dispose();
});

test('failed exact-grant detach preserves the attachment and permits cleanup retry without selecting again', async () => {
    const options = { fail: true, attach: async () => { throw Error('attach ACK lost'); },
        detach: async () => { if (options.fail) throw Error('detach ACK lost'); } };
    const f = fixture(options), port = await f.bind();
    await assert.rejects(port.request(request(1, 'select'), new AbortController().signal), /detach ACK lost/);
    assert.equal(f.ports.every(port => !port.closed), true); await assert.rejects(port.close(), /cleanup remains unconfirmed/);
    assert.equal(f.calls.includes('holder-release'), false);
    options.fail = false; await port.close();
    assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === 'request').length, 1);
    assert.equal(f.ports.every(port => port.closed), true); await f.manager.dispose();
});

test('original owner release retains its callback through Main-only failed server cleanup', async () => {
    const options = { fail: true, serverClose: async () => { if (options.fail) throw Error('server not closed'); } };
    const f = fixture(options), port = await f.bind(); await port.request(request(1, 'select'), new AbortController().signal);
    const callback = [...f.callbacks][0]; assert.equal(typeof callback, 'function');
    await assert.rejects(callback(), /cleanup remains unconfirmed/); assert(f.callbacks.has(callback));
    assert.equal(f.calls.includes('holder-release'), false); options.fail = false; await callback();
    assert.equal(f.callbacks.size, 0); assert(f.calls.includes('holder-release')); await f.manager.dispose();
});

test('a renewed original port accepts sequence one while late old cleanup cannot retire the new binding', async () => {
    const f = fixture(), old = await f.bind(), signal = new AbortController().signal;
    await old.request(request(1), signal); await old.close();
    const current = await f.bind(); await current.request(request(1, 'select'), signal);
    const count = f.calls.length; await old.close();
    await assert.rejects(old.request(request(2, 'release'), signal), /owner ended/);
    assert.equal(f.calls.length, count); assert.equal(f.ports.every(port => !port.closed), true);
    await current.request(request(2), signal);
    assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === 'lifetime-ended').length, 1);
    await current.close(); assert.equal(f.ports.every(port => port.closed), true);
    assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === 'lifetime-ended').length, 2);
    await f.manager.dispose();
});
