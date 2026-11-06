'use strict';
// Actual Main helper/ControllerPort/tuple boundary and actual Protocol; in-memory
// original owner only. No Main/UI, process, socket, DNS, Worker or Core is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const main = path.resolve(__dirname, '..');
const sim = process.env.AILY_NETWORK_TEST_PROTOCOL_ROOT || process.env.AILY_G2B_SIMULATOR_SOURCE_ROOT || path.resolve(main, '../../simulator/source');
const protocol = require(sim + '/packages/simulator-protocol/dist/public/host.js');
const boundaryProtocol = { ...require(sim + '/packages/simulator-protocol/dist/connectivity-host.js'), ...require(sim + '/packages/simulator-protocol/dist/connectivity-network-provider.js') };
function helper(name) {
    const source = fs.readFileSync(main + '/src/app/services/integrations/subapps/host-provider/' + name + '.ts', 'utf8');
    const built = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', built)(id => { assert.equal(id, '@aily-project/simulator-protocol/host'); return protocol; }, module, module.exports);
    return module.exports;
}
const { createWorkspaceNetworkLifecycle } = helper('subapp-workspace-network-lifecycle');
const { createWorkspaceNetworkControllerPort } = helper('subapp-workspace-network-controller-port');
const { createMainNetworkHostBoundary } = require('./subapp-network-host-boundary');
const { createMainNetworkEndpointSelection } = require('./subapp-network-endpoint-selection');
const turn = () => new Promise(resolve => setImmediate(resolve));
const request = (operation, number) => ({ schemaVersion: 1, kind: 'aily-host-network-provider-request', requestId: 'real-' + number, requestSequence: number, operation });
const identity = number => ({ schemaVersion: 1, kind: 'aily-host-network-binding-close-identity', hostInstanceId: 'host:original',
    selection: { requestId: 'real-' + number, requestSequence: number }, grant: { grantId: 'grant-' + number, backendId: 'backend', executionId: 'execution', profileId: 'wifi-functional-host-ip-v1',
        scope: { sessionId: 'session', sceneRevision: 'a'.repeat(64), worldId: 'world', nodeId: 'node', clockDomainId: 'clock', runtimeGeneration: 1, coreGeneration: 2, timeEpoch: 3, connectionEpoch: 4 } } });
const state = (number, revision = 1) => ({ ...identity(number), kind: 'aily-host-network-binding-lifecycle', phase: 'closing', revision });
const selected = (number, q) => ({ schemaVersion: 1, kind: 'aily-host-network-provider-result', requestId: q.requestId, requestSequence: q.requestSequence, operation: 'select', ok: true, outcome: 'selected',
    grant: { schemaVersion: 1, kind: 'aily-host-connectivity-grant', ...identity(number).grant, capability: 'network.ip', executionLocation: 'user-device', resourceLocation: 'user-device', permissionAuthority: 'local-user', expiresAtUnixMs: 1, resourceIds: ['peer'] } });
const failure = (q, errorCode) => ({ schemaVersion: 1, kind: 'aily-host-network-provider-result', requestId: q.requestId, requestSequence: q.requestSequence, operation: 'select', ok: false, errorCode });
const close = (original, number = 1) => ({ type: protocol.SIMULATOR_SUBAPP_HOST_PROVIDER_TRANSPORT_MESSAGE_TYPES.networkBindingClose, version: 1, requestId: 'cleanup-' + number, original });
function fixture() {
    const h = { closes: 0, fail: false, sent: [] };
    h.life = createWorkspaceNetworkLifecycle({ hostInstanceId: 'host:original', async closeOriginal() { h.closes++; if (h.fail) throw new Error('controlled close failure'); }, async send(value) { h.sent.push(value); } });
    h.select = number => { const q = request('select', number); h.life.observeDispatch(q); h.life.observeExchange(q, selected(number, q)); };
    return h;
}
test('D13 old RAW lifecycle cannot close a real selected successor; current identity remains cleanable', async () => {
    const h = fixture(); h.select(1); assert(h.life.observe(state(1))); h.select(3);
    h.life.handleClose(close(state(1))); await h.life.whenIdle(); assert.equal(h.closes, 0);
    h.life.handleClose(close(identity(3), 2)); await h.life.whenIdle(); assert.equal(h.closes, 1); assert.equal(h.sent.at(-1).outcome.ok, true);
});
test('D13 old RAW during foreign successor reservation is fenced and no known close is acknowledged', async () => {
    const h = fixture(); h.select(1); assert(h.life.observe(state(1))); h.life.observeDispatch(request('select', 3));
    h.life.handleClose(close(state(1))); await h.life.whenIdle(); assert.equal(h.closes, 0); assert.deepEqual(h.sent.at(-1).outcome, { ok: false, errorCode: 'cleanup-unconfirmed' });
    h.life.observeExchange(request('select', 3), failure(request('select', 3), 'busy'));
    h.life.handleClose(close(state(1), 2)); await h.life.whenIdle(); assert.equal(h.closes, 1); assert.equal(h.sent.at(-1).outcome.ok, true);
});
test('D13 actual close microtask rechecks a newer selected identity and a newly dispatched foreign reservation', async () => {
    for (const mode of ['selected', 'pending']) {
        const h = fixture(); h.select(1); assert(h.life.observe(state(1))); h.life.handleClose(close(state(1)));
        if (mode === 'selected') h.select(3); else h.life.observeDispatch(request('select', 3));
        await h.life.whenIdle(); assert.equal(h.closes, 0); assert.equal(h.sent.at(-1).outcome.ok, false);
    }
});
test('D13 same-grant revision and phase replacement is stable identity, never an object-pointer fence', async () => {
    for (const hasSelected of [false, true]) {
        const h = fixture(); if (hasSelected) h.select(1); assert(h.life.observe(state(1))); h.life.handleClose(close(state(1)));
        assert(h.life.observe({ ...state(1, 2), phase: 'cleanup-unconfirmed' }));
        await h.life.whenIdle(); assert.equal(h.closes, 1); assert.equal(h.sent.at(-1).outcome.ok, true);
    }
});
async function pendingActualOwner({ previousSelection }) {
    const sent = [], entered = Promise.withResolvers(), held = Promise.withResolvers(); let closes = 0, life, port;
    const pendingNumber = previousSelection ? 3 : 1;
    const originalPort = { async request(q) {
        if (q.operation === 'release') return { schemaVersion: 1, kind: 'aily-host-network-provider-result', requestId: q.requestId, requestSequence: q.requestSequence, operation: 'release', ok: true, state: 'released', releasedGrants: 1 };
        if (q.requestSequence !== pendingNumber) return selected(1, q);
        // Trusted original Main owner emits its real partial-grant lifecycle
        // before this same acquisition's ordinary selected reply is delivered.
        assert(life.observe(state(pendingNumber))); entered.resolve(); return held.promise;
    }, async close() { closes++; held.resolve(selected(pendingNumber, request('select', pendingNumber))); } };
    const sender = { id: 7, mainFrame: {}, isDestroyed: () => false }, mainWindow = { webContents: sender, isDestroyed: () => false }, event = { sender, senderFrame: sender.mainFrame }, tuple = { toolId: 'simulator', streamId: 'stream', bindingId: 'binding' };
    const selection = createMainNetworkEndpointSelection({ resources: [{ endpointId: 'peer', label: 'Memory only', detail: 'No OS', transports: ['udp'], recordTypes: ['A'] }], showChooser: async () => ({ outcome: 'selected', endpointId: 'peer' }) });
    const boundary = createMainNetworkHostBoundary({ protocol: boundaryProtocol, getMainWindow: () => mainWindow, requireController() {}, selection, resolveOriginalOwnerNetworkPort: async () => originalPort });
    life = createWorkspaceNetworkLifecycle({ hostInstanceId: 'host:original', closeOriginal: () => port.close(), send: async value => sent.push(value) });
    port = createWorkspaceNetworkControllerPort({ requireCurrentBinding() {}, invoke: input => boundary.invoke(event, { ...input, ...tuple }), observeDispatch: q => life.observeDispatch(q), observeResult: (q, result) => life.observeExchange(q, result) });
    const signal = new AbortController().signal;
    if (previousSelection) { assert((await port.request(request('select', 1), signal)).ok); assert((await port.request(request('release', 2), signal)).ok); assert.equal(life.snapshot().retained, null); }
    const selecting = port.request(request('select', pendingNumber), signal); const settled = selecting.then(value => ({ value }), error => ({ error }));
    await entered.promise; life.handleClose(close(state(pendingNumber))); await life.whenIdle();
    assert.equal(closes, 1); assert.equal(sent.at(-1).outcome.ok, true); assert.equal(boundary.snapshot().bindings, 0); assert((await settled).error, 'Cleanup does not fake a successful ordinary select'); await boundary.dispose();
}
test('D13 unique own pending first select still closes trusted partial Main owner before its late result', () => pendingActualOwner({ previousSelection: false }));
test('D13 old selection1 released, select2 held and trusted state2 before ACK remains cleanable despite retained selected1', () => pendingActualOwner({ previousSelection: true }));
test('D13 exact own initial reservation is no exemption when any foreign reservation is also pending', async () => {
    const h = fixture(); h.life.observeDispatch(request('select', 1)); assert(h.life.observe(state(1))); h.life.observeDispatch(request('select', 3));
    h.life.handleClose(close(state(1))); await h.life.whenIdle(); assert.equal(h.closes, 0); assert.equal(h.sent.at(-1).outcome.ok, false);
    h.life.observeExchange(request('select', 3), failure(request('select', 3), 'busy')); h.life.handleClose(close(state(1), 2)); await h.life.whenIdle(); assert.equal(h.closes, 1);
});
test('D13 RAW failed cleanup retains original stable identity for explicit retry without business replay', async () => {
    const h = fixture(); h.select(1); assert(h.life.observe(state(1))); h.fail = true;
    h.life.handleClose(close(state(1))); await h.life.whenIdle(); assert.equal(h.sent.at(-1).outcome.ok, false); assert.equal(h.life.snapshot().retained.grant.grantId, 'grant-1');
    h.fail = false; assert(h.life.observe(state(1, 2))); h.life.handleClose(close(state(1), 2)); await h.life.whenIdle(); assert.equal(h.closes, 2); assert.equal(h.sent.at(-1).outcome.ok, true);
});
test('D13 foreign full tuple still cannot close even with matching own request correlation', async () => {
    for (const change of [x => x.hostInstanceId = 'foreign', x => x.grant.grantId = 'foreign', x => x.grant.scope.timeEpoch++, x => x.selection.requestSequence++]) {
        const h = fixture(); h.life.observeDispatch(request('select', 1)); assert(h.life.observe(state(1))); const wrong = structuredClone(state(1)); change(wrong);
        h.life.handleClose(close(wrong)); await h.life.whenIdle(); assert.equal(h.closes, 0);
    }
});
test('D13 unknown old own reservation never exempts a later real selected successor, including close microtask reentry', async () => {
    for (const beforeSuccessor of [true, false]) {
        const h = fixture(); h.life.observeDispatch(request('select', 1)); assert(h.life.observe(state(1)));
        if (beforeSuccessor) h.life.handleClose(close(state(1)));
        h.select(3); // Unknown1 stays reserved after actual newer selection3.
        if (!beforeSuccessor) h.life.handleClose(close(state(1)));
        await h.life.whenIdle(); assert.equal(h.closes, 0);
        h.life.handleClose(close(identity(3), 2)); await h.life.whenIdle(); assert.equal(h.closes, 0, 'Original unknown reservation remains fenced, never erased');
    }
});
