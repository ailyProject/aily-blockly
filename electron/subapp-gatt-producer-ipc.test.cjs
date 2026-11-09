'use strict';
// Actual Main producer boundary + actual Renderer port + shared DTO validators.
// The original resource-free provider stub performs no OS, firmware or UI work.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const { createMainGattHostBoundary } = require('./subapp-gatt-host-boundary');
const { createMainGattNativeChooser } = require('./subapp-gatt-native-chooser');
const api = require(process.env.AILY_GATT_TEST_MODULE || '/Volumes/data/aily-work/work/w8-gatt-message-port-20261108-a01/main-module-a01/local-gatt-backend.cjs');
let createPort;
test.before(async () => {
    const main = path.resolve(__dirname, '..');
    const simulator = process.env.AILY_GATT_TEST_SOURCE_ROOT || '/Volumes/data/codes/aily-simulator-w8-browser-gatt';
    const result = await build({ absWorkingDir: main, entryPoints: ['src/app/services/integrations/subapps/host-provider/subapp-workspace-gatt-controller-port.ts'],
        bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'actual-shared-producer-contract', setup(builder) {
            builder.onResolve({ filter: /^@aily-project\/simulator-protocol\/host$/ }, () => ({ path: path.join(simulator, 'packages/simulator-protocol/src/connectivity-gatt-binding.ts') }));
        } }] });
    ({ createWorkspaceGattControllerPort: createPort } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')));
});
const sig = () => new AbortController().signal;
const request = (sequence, operation = 'catalog') => ({ schemaVersion: 1, kind: 'aily-host-gatt-provider-request', requestId: 'business-' + sequence, requestSequence: sequence, operation });
function fixture(t) {
    const sender = { id: 7, mainFrame: {}, isDestroyed: () => false }, main = { webContents: sender, isDestroyed: () => false };
    const event = { sender, senderFrame: sender.mainFrame };
    const h = { current: true, failClose: false, requests: [], closes: 0, allocations: 0, networkClosures: 0,
        stateHook: null, invalidState: false };
    const choosePeer = createMainGattNativeChooser({ getMainWindow: () => main, dialog: { async showMessageBox() { throw Error('No UI in this test'); } },
        backend: { scan() { throw Error('No scan in this test'); }, createDriver() { throw Error('No Native in this test'); }, releaseSelection() {} } });
    const boundary = createMainGattHostBoundary({ protocol: api, getMainWindow: () => main,
        requireController() { if (!h.current) throw Error('Original controller ended'); }, choosePeer,
        async resolveOriginalOwnerGattPort(input) {
            h.allocations++; let sequence = 0;
            return { async request(value) {
                assert.equal(value.requestSequence, ++sequence); h.requests.push({ producerId: input.producerId, operation: value.operation });
                return api.validateHostGattProviderExchangeV1(value, { schemaVersion: 1, kind: 'aily-host-gatt-provider-result',
                    requestId: value.requestId, requestSequence: value.requestSequence, operation: value.operation, ok: true,
                    ...(value.operation === 'release' ? { state: 'released', releasedGrants: 0 } : { catalog: api.createUnavailableHostConnectivityCatalogV1() }) });
            }, async close() { h.closes++; if (h.failClose) throw Error('Original close is unconfirmed'); } };
        } });
    const invoke = async input => {
        const result = await boundary.invoke(event, { toolId: 'simulator', streamId: 'stream', bindingId: 'workspace', ...input });
        if (input.action === 'binding-state') {
            if (h.stateHook) return h.stateHook(result);
            if (h.invalidState) return { ...result, unexpected: true };
        }
        return result;
    };
    const port = createPort({ invoke, requireCurrentBinding(cleanup) { if (!cleanup && !h.current) throw Error('Original workspace ended'); } });
    t.after(async () => { h.current = true; h.failClose = false; h.stateHook = null; await port.close(); await boundary.dispose(); });
    return { h, port, boundary, invoke };
}

test('GATT renews its producer without closing Network; old requests and cleanup cannot target successor', async t => {
    const f = fixture(t), first = await f.port.bindingState(sig());
    const value = await f.port.request(first.producerId, request(1), sig()); assert.equal(value.producerId, first.producerId);
    await f.port.closeProducer(first.producerId);
    const next = await f.port.bindingState(sig()); assert.notEqual(next.producerId, first.producerId);
    await f.port.request(next.producerId, request(1), sig()); const count = f.h.requests.length;
    await assert.rejects(async () => f.port.request(first.producerId, request(2), sig()));
    await f.port.closeProducer(first.producerId); assert.equal(f.h.requests.length, count);
    assert.equal(f.h.networkClosures, 0); assert.equal((await f.port.bindingState(sig())).producerId, next.producerId);
});

test('a delayed old state reply cannot fence the active successor', async t => {
    const f = fixture(t), first = await f.port.bindingState(sig()); await f.port.request(first.producerId, request(1), sig());
    let resolve; f.h.stateHook = value => { f.h.stateHook = null; return new Promise(done => { resolve = () => done(value); }); };
    const old = f.port.bindingState(sig()); await new Promise(done => setImmediate(done));
    await f.port.closeProducer(first.producerId); const next = await f.port.bindingState(sig()); resolve();
    await assert.rejects(old, /Stale GATT producer/);
    assert.equal((await f.port.request(next.producerId, request(1), sig())).producerId, next.producerId);
});

test('malformed state is rejected before changing or cleaning a valid producer', async t => {
    const f = fixture(t), first = await f.port.bindingState(sig()); await f.port.request(first.producerId, request(1), sig());
    f.h.invalidState = true; await assert.rejects(f.port.bindingState(sig())); f.h.invalidState = false;
    assert.equal(f.h.closes, 0); await f.port.request(first.producerId, request(2), sig()); assert.equal(f.h.allocations, 1);
});

test('fenced Renderer port permits exact original release after failed close and current-controller loss', async t => {
    const f = fixture(t), first = await f.port.bindingState(sig()); await f.port.request(first.producerId, request(1), sig());
    f.h.failClose = true; await assert.rejects(f.port.closeProducer(first.producerId));
    f.h.current = false; f.h.failClose = false;
    const actual = await f.port.request(first.producerId, request(2, 'release'), sig());
    assert.equal(actual.producerId, first.producerId); assert.equal(actual.result.state, 'released');
    assert.deepEqual(f.h.requests.at(-1), { producerId: first.producerId, operation: 'release' });
    f.h.current = true; const next = await f.port.bindingState(sig()); assert.notEqual(next.producerId, first.producerId);
    assert.equal(f.h.networkClosures, 0);
});
