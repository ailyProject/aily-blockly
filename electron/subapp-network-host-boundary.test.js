'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { createMainNetworkHostBoundary, registerMainNetworkHostHandlers } = require('./subapp-network-host-boundary');
const { createMainNetworkEndpointSelection, isMainNetworkEndpointSelection } = require('./subapp-network-endpoint-selection');
let protocol;
test.before(async () => {
    // Only this test loader accepts an explicit immutable package build root.
    // Production Main has no development source path or test admission flag.
    const root = process.env.AILY_NETWORK_TEST_PROTOCOL_ROOT;
    const load = name => root ? import(pathToFileURL(root + '/packages/simulator-protocol/dist/' + name + '.js'))
        : import('@aily-project/simulator-protocol/' + name);
    protocol = { ...await load('connectivity-network-provider'), ...await load('connectivity-host') };
});
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const resource = () => ({ endpointId: 'selected.peer', label: 'Controlled peer', detail: '127.0.0.1:8090 · TCP/UDP · fixed A allowlist', transports: ['tcp', 'udp'], recordTypes: ['A'] });
const selection = showChooser => createMainNetworkEndpointSelection({ resources: [resource()], showChooser: showChooser || (async () => ({ outcome: 'cancelled' })) });
const request = (requestId = 'request.1', operation = 'catalog', requestSequence = 1) => ({ schemaVersion: 1, kind: 'aily-host-network-provider-request', requestId, requestSequence, operation });
const reply = req => ({ schemaVersion: 1, kind: 'aily-host-network-provider-result', requestId: req.requestId, requestSequence: req.requestSequence, operation: req.operation, ok: false, errorCode: 'unavailable' });
function harness(options = {}) {
    const sender = { id: 7, mainFrame: {}, isDestroyed: () => false }, main = { webContents: sender, isDestroyed: () => false };
    const event = { sender, senderFrame: sender.mainFrame }; let live = true, factoryCalls = 0;
    const requireController = (id, authority) => { assert.equal(id, 7); assert.equal(authority.toolId, 'simulator'); if (!live) throw Error('controller ended'); };
    const boundary = createMainNetworkHostBoundary({ protocol, getMainWindow: () => main, requireController,
        ...options, ...(options.resolveOriginalOwnerNetworkPort ? { resolveOriginalOwnerNetworkPort: async input => { factoryCalls++; return options.resolveOriginalOwnerNetworkPort(input); } } : {}) });
    const envelope = (req, bindingId = 'binding.1') => ({ action: 'request', toolId: 'simulator', streamId: 'stream.1', bindingId, request: req });
    return { boundary, event, sender, main, envelope, retireController: () => { live = false; }, factoryCalls: () => factoryCalls };
}
test('absent config/chooser/original owner is unavailable without allocating a binding', async () => {
    for (const options of [{}, { selection: selection() }, { resolveOriginalOwnerNetworkPort: async () => assert.fail('no selection') }, { selection: { endpointIds: ['selected.peer'], chooseEndpoints() {} }, resolveOriginalOwnerNetworkPort: async () => assert.fail('forged selection') }]) {
        const h = harness(options), result = await h.boundary.invoke(h.event, h.envelope(request()));
        assert(result.ok); assert.deepEqual(result.catalog.backends, []); assert.equal(h.boundary.snapshot().configured, false); assert.equal(h.factoryCalls(), 0); assert.equal(h.boundary.snapshot().bindings, 0);
        assert.equal((await h.boundary.invoke(h.event, h.envelope(request('select.1', 'select')))).errorCode, 'unavailable'); await h.boundary.dispose();
    }
});
test('registration exposes only the dedicated normal IPC channel and records its actual host owner', async () => {
    const h = harness(); let channel, handler, installed;
    const host = registerMainNetworkHostHandlers({ protocol, getMainWindow: () => h.main, requireController: () => {},
        ipcMain: { handle(name, callback) { channel = name; handler = callback; } }, installHost(value) { installed = value; } });
    assert.equal(channel, 'subapp-local-network'); assert.equal(installed, host);
    assert.deepEqual((await handler(h.event, h.envelope(request()))).catalog.backends, []);
    await host.dispose(); await h.boundary.dispose();
});
test('Main IPC requires actual main sender/frame and current exact controller', async () => {
    const h = harness();
    for (const event of [{ ...h.event, sender: { ...h.sender } }, { ...h.event, senderFrame: {} }]) assert.equal((await h.boundary.invoke(event, h.envelope(request()))).errorCode, 'permission-denied');
    h.retireController(); assert.equal((await h.boundary.invoke(h.event, h.envelope(request()))).errorCode, 'permission-denied'); await h.boundary.dispose();
});
test('browser cannot add destination, scope, sender identity or an accessor', async () => {
    const h = harness(); let getters = 0;
    for (const extra of [{ url: 'https://peer.example' }, { scope: { generation: 1 } }, { senderId: 99 }]) assert.equal((await h.boundary.invoke(h.event, { ...h.envelope(request()), ...extra })).errorCode, 'invalid-input');
    const bad = h.envelope(request()); Object.defineProperty(bad, 'request', { enumerable: true, get() { getters++; return request(); } });
    assert.equal((await h.boundary.invoke(h.event, bad)).errorCode, 'invalid-input'); assert.equal(getters, 0); assert.equal(h.factoryCalls(), 0); await h.boundary.dispose();
});
test('shared DTO validator rejects select-scope/URL injection and malformed request before factory', async () => {
    const h = harness({ selection: selection(), resolveOriginalOwnerNetworkPort: async () => assert.fail('invalid DTO') });
    for (const bad of [{ ...request('select', 'select'), scope: {} }, { ...request(), url: 'tcp://127.0.0.1:1' }, { ...request(), requestSequence: 0 }]) assert.equal((await h.boundary.invoke(h.event, h.envelope(bad))).errorCode, 'invalid-input');
    assert.equal(h.factoryCalls(), 0); await h.boundary.dispose();
});
test('trusted future owner resolver gets exact channel and selection, request forwarded once without synthesized scope', async () => {
    let authority, calls = 0, closes = 0;
    const s = selection(), h = harness({ selection: s, resolveOriginalOwnerNetworkPort: async input => { authority = input; return { request: async (req, signal) => { assert(signal instanceof AbortSignal); calls++; return reply(req); }, close: async () => { closes++; } }; } });
    const req = request(); assert.equal((await h.boundary.invoke(h.event, h.envelope(req))).errorCode, 'unavailable');
    assert.deepEqual(authority.authority, { senderId: 7, toolId: 'simulator', streamId: 'stream.1', bindingId: 'binding.1' }); assert.equal(authority.selection, s); assert(!Object.hasOwn(authority, 'scope')); assert.equal(typeof authority.requireCurrentController, 'function'); assert.equal(calls, 1); assert.equal(h.factoryCalls(), 1);
    await h.boundary.dispose(); assert.equal(closes, 1); assert.equal(h.boundary.snapshot().bindings, 0);
});
test('positively absent original owner returns unavailable and a later real owner may be resolved afresh', async () => {
    let available = false, closes = 0;
    const h = harness({ selection: selection(), resolveOriginalOwnerNetworkPort: async () => available ? { request: async req => reply(req), close: async () => { closes++; } } : null });
    assert.deepEqual((await h.boundary.invoke(h.event, h.envelope(request()))).catalog.backends, []); assert.equal(h.boundary.snapshot().bindings, 0);
    available = true; assert.equal((await h.boundary.invoke(h.event, h.envelope(request('next', 'catalog', 2)))).errorCode, 'unavailable'); assert.equal(h.factoryCalls(), 2); assert.equal(h.boundary.snapshot().bindings, 1); await h.boundary.dispose(); assert.equal(closes, 1);
});
test('channel retirement during async acquisition captures and closes the late original port', async () => {
    const gate = deferred(); let started = deferred(), closes = 0, sends = 0;
    const h = harness({ selection: selection(), resolveOriginalOwnerNetworkPort: () => { started.resolve(); return gate.promise; } });
    const pending = h.boundary.invoke(h.event, h.envelope(request())); await started.promise; h.retireController();
    gate.resolve({ request: async () => { sends++; assert.fail('late owner must not execute'); }, close: async () => { closes++; } });
    assert.equal((await pending).errorCode, 'permission-denied'); assert.equal(sends, 0); assert.equal(closes, 1); assert.equal(h.boundary.snapshot().bindings, 0);
    await h.boundary.closeBinding({ senderId: 7, toolId: 'simulator', streamId: 'stream.1', bindingId: 'binding.1' }); assert.equal(h.boundary.snapshot().bindings, 0); await h.boundary.dispose();
});
test('cancel addresses only this exact binding request and is not a completion ACK', async () => {
    const started = deferred(); let closes = 0, seenSignal;
    const h = harness({ selection: selection(), resolveOriginalOwnerNetworkPort: async () => ({ request: (req, signal) => { seenSignal = signal; started.resolve(); return new Promise(resolve => signal.addEventListener('abort', () => resolve(reply(req)), { once: true })); }, close: async () => { closes++; } }) });
    const pending = h.boundary.invoke(h.event, h.envelope(request('pending'))); await started.promise;
    const cancel = { action: 'cancel', toolId: 'simulator', streamId: 'stream.1', bindingId: 'binding.other', requestId: 'pending' };
    assert.equal((await h.boundary.invoke(h.event, cancel)).cancelRequested, false); assert.equal(seenSignal.aborted, false);
    const ack = await h.boundary.invoke(h.event, { ...cancel, bindingId: 'binding.1' }); assert.deepEqual(ack, { ok: true, cancelRequested: true, completionConfirmed: false });
    assert.equal((await pending).errorCode, 'cancelled'); assert.equal(seenSignal.aborted, true); assert.equal(closes, 1); await h.boundary.dispose();
});
test('close joins the actual port close and original pending work before ACK', async () => {
    const started = deferred(), closeGate = deferred(); let wake;
    const h = harness({ selection: selection(), resolveOriginalOwnerNetworkPort: async () => ({ request: req => { started.resolve(); return new Promise(resolve => { wake = () => resolve(reply(req)); }); }, close: async () => { wake(); await closeGate.promise; } }) });
    const pending = h.boundary.invoke(h.event, h.envelope(request('pending'))); await started.promise;
    let closed = false; const closing = h.boundary.invoke(h.event, { action: 'close', toolId: 'simulator', streamId: 'stream.1', bindingId: 'binding.1' }).then(value => { closed = true; return value; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(closed, false); closeGate.resolve(); assert.equal((await closing).closed, true); assert.equal((await pending).errorCode, 'cancelled'); assert.equal(h.boundary.snapshot().pending, 0); assert.equal(h.boundary.snapshot().bindings, 0); await h.boundary.dispose();
});
test('failed original close retains fenced owner; explicit retry never resends request', async () => {
    let calls = 0, closes = 0;
    const h = harness({ selection: selection(), resolveOriginalOwnerNetworkPort: async () => ({ request: async () => { calls++; return { invalid: true }; }, close: async () => { if (++closes === 1) throw Error('actual close unconfirmed'); } }) });
    assert.equal((await h.boundary.invoke(h.event, h.envelope(request()))).errorCode, 'cleanup-unconfirmed'); assert.equal(h.boundary.snapshot().bindings, 1); assert.equal(h.boundary.snapshot().fenced, 1);
    await h.boundary.closeBinding({ senderId: 7, toolId: 'simulator', streamId: 'stream.1', bindingId: 'binding.1' }); assert.equal(calls, 1); assert.equal(closes, 2); assert.equal(h.factoryCalls(), 1); assert.equal(h.boundary.snapshot().bindings, 0); await h.boundary.dispose();
});
test('duplicate in-flight request is refused rather than executed twice', async () => {
    const gate = deferred(), started = deferred(); let calls = 0;
    const h = harness({ selection: selection(), resolveOriginalOwnerNetworkPort: async () => ({ request: async req => { calls++; started.resolve(); await gate.promise; return reply(req); }, close: async () => {} }) });
    const pending = h.boundary.invoke(h.event, h.envelope(request())); await started.promise; assert.equal((await h.boundary.invoke(h.event, h.envelope(request()))).errorCode, 'request-replayed'); gate.resolve(); await pending; assert.equal(calls, 1); await h.boundary.dispose();
});
test('endpoint chooser is absent without normal configuration/UI and has no selected default', async () => {
    assert.equal(createMainNetworkEndpointSelection(), null); assert.equal(createMainNetworkEndpointSelection({ resources: [resource()] }), null); let shown;
    const s = selection(async value => { shown = value; return { outcome: 'selected', endpointId: 'selected.peer' }; }); assert(isMainNetworkEndpointSelection(s)); assert(!isMainNetworkEndpointSelection({ chooseEndpoints() {} }));
    const result = await s.chooseEndpoints({ choices: [{ endpointId: 'selected.peer', transports: ['tcp', 'udp'], recordTypes: ['A'] }] }, new AbortController().signal, () => {});
    assert.equal(shown.initialSelection, null); assert.deepEqual(result, { outcome: 'selected', resourceIds: ['selected.peer'] }); assert(!Object.hasOwn(result, 'scope')); assert(!Object.hasOwn(result, 'url'));
});
test('chooser snapshots configuration and rejects backend drift or foreign selected ID', async () => {
    const row = resource(); let shown = 0; const s = createMainNetworkEndpointSelection({ resources: [row], showChooser: async () => { shown++; return { outcome: 'selected', endpointId: 'foreign' }; } }); row.endpointId = 'mutated';
    assert.deepEqual(s.endpointIds, ['selected.peer']); await assert.rejects(s.chooseEndpoints({ choices: [] }, new AbortController().signal, () => {})); assert.equal(shown, 0);
    await assert.rejects(s.chooseEndpoints({ choices: [{ endpointId: 'selected.peer', transports: ['tcp', 'udp'], recordTypes: ['A'] }] }, new AbortController().signal, () => {})); assert.equal(shown, 1);
});
test('late chooser after abort or authority retirement cannot issue selection', async () => {
    const gate = deferred(), abort = new AbortController(); let checks = 0; const s = selection(() => gate.promise), choices = [{ endpointId: 'selected.peer', transports: ['tcp', 'udp'], recordTypes: ['A'] }];
    const result = s.chooseEndpoints({ choices }, abort.signal, () => { checks++; }); abort.abort(); gate.resolve({ outcome: 'selected', endpointId: 'selected.peer' }); assert.deepEqual(await result, { outcome: 'cancelled' }); assert.equal(checks, 2);
    const retired = selection(async () => ({ outcome: 'selected', endpointId: 'selected.peer' })); let count = 0; await assert.rejects(retired.chooseEndpoints({ choices }, new AbortController().signal, () => { if (++count === 2) throw Error('original owner ended'); }), /original owner ended/);
});
test('chooser result cannot smuggle URL/scope and configuration accessors are not invoked', async () => {
    for (const extra of [{ url: 'tcp://elsewhere' }, { scope: {} }]) { const s = selection(async () => ({ outcome: 'selected', endpointId: 'selected.peer', ...extra })); await assert.rejects(s.chooseEndpoints({ choices: [{ endpointId: 'selected.peer', transports: ['tcp', 'udp'], recordTypes: ['A'] }] }, new AbortController().signal, () => {})); }
    let reads = 0; const row = resource(); Object.defineProperty(row, 'detail', { enumerable: true, get() { reads++; return 'bad'; } }); assert.throws(() => createMainNetworkEndpointSelection({ resources: [row], showChooser: async () => ({ outcome: 'cancelled' }) })); assert.equal(reads, 0);
});
