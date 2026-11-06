'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const loaded = esbuild.build({ entryPoints: [path.join(root, 'src/app/services/integrations/subapps/host-provider/subapp-workspace-network-controller-port.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' }).then(result => {
    const filename = path.join(__dirname, 'network-controller-port-test.cjs'), compiled = new Module(filename, module);
    compiled.filename = filename; compiled.paths = Module._nodeModulePaths(root); compiled._compile(result.outputFiles[0].text, filename); return compiled.exports;
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('workspace port carries original request unchanged and has no scope/destination authority', async () => {
    const { createWorkspaceNetworkControllerPort } = await loaded, calls = [], guards = [];
    const port = createWorkspaceNetworkControllerPort({ requireCurrentBinding: cleanup => guards.push(cleanup), invoke: async value => { calls.push(value); return value.action === 'close' ? { ok: true, closed: true } : { actual: true }; } });
    const request = { requestId: 'request.1', payload: { dataBase64: 'AP+A', dataByteLength: 3 } };
    assert.deepEqual(await port.request(request, new AbortController().signal), { actual: true }); assert.equal(calls[0].request, request); assert.deepEqual(Object.keys(calls[0]), ['action', 'request']);
    await port.close(); assert.deepEqual(calls.map(value => value.action), ['request', 'close']); assert(guards.includes(false)); assert(guards.includes(true));
});
test('abort dispatches one targeted cancel and rejects actual late completion without replay', async () => {
    const { createWorkspaceNetworkControllerPort } = await loaded, gate = deferred(), calls = [], abort = new AbortController();
    const port = createWorkspaceNetworkControllerPort({ requireCurrentBinding() {}, invoke: async value => { calls.push(value); return value.action === 'request' ? gate.promise : value.action === 'cancel' ? { ok: true, completionConfirmed: false } : { ok: true, closed: true }; } });
    const pending = port.request({ requestId: 'pending' }, abort.signal); await tick(); abort.abort(); abort.abort(); gate.resolve({ tooLate: true });
    await assert.rejects(pending, /cancellation/); assert.deepEqual(calls.map(value => value.action), ['request', 'cancel']); assert.deepEqual(calls[1], { action: 'cancel', requestId: 'pending' }); await port.close();
});
test('already-aborted work and duplicate pending ID cannot be dispatched', async () => {
    const { createWorkspaceNetworkControllerPort } = await loaded, gate = deferred(); let requests = 0;
    const port = createWorkspaceNetworkControllerPort({ requireCurrentBinding() {}, invoke: async value => { if (value.action === 'close') return { ok: true, closed: true }; requests++; return gate.promise; } });
    const abort = new AbortController(); abort.abort(); await assert.rejects(port.request({ requestId: 'aborted' }, abort.signal)); assert.equal(requests, 0);
    const first = port.request({ requestId: 'same' }, new AbortController().signal); await assert.rejects(port.request({ requestId: 'same' }, new AbortController().signal)); assert.equal(requests, 1); gate.resolve({ ok: true }); await first; await port.close();
});
test('close wakes original work and joins its terminal completion before acknowledgement', async () => {
    const { createWorkspaceNetworkControllerPort } = await loaded, requestGate = deferred(), closeGate = deferred(), calls = [];
    const port = createWorkspaceNetworkControllerPort({ requireCurrentBinding() {}, invoke: async value => { calls.push(value.action); if (value.action === 'request') return requestGate.promise; requestGate.resolve({ afterClose: true }); await closeGate.promise; return { ok: true, closed: true }; } });
    const pending = port.request({ requestId: 'pending' }, new AbortController().signal); let closed = false; const closing = port.close().then(() => { closed = true; });
    await assert.rejects(pending, /cancellation/); assert.equal(closed, false); closeGate.resolve(); await closing; assert.equal(closed, true); assert.deepEqual(calls, ['request', 'close']);
});
test('failed cleanup retains the same close path for explicit retry and fences new requests', async () => {
    const { createWorkspaceNetworkControllerPort } = await loaded; let attempts = 0;
    const port = createWorkspaceNetworkControllerPort({ requireCurrentBinding() {}, invoke: async value => { if (value.action === 'request') return { actual: true }; assert.equal(value.action, 'close'); return { ok: ++attempts !== 1, closed: attempts !== 1 }; } });
    await port.request({ requestId: 'original' }, new AbortController().signal);
    await assert.rejects(port.close(), /unconfirmed/); await assert.rejects(port.request({ requestId: 'late' }, new AbortController().signal)); await port.close(); assert.equal(attempts, 2);
});
test('unused channel cleanup requires its original local binding and sends no unknown Main cleanup', async () => {
    const { createWorkspaceNetworkControllerPort } = await loaded, guards = []; let current = false, calls = 0;
    const port = createWorkspaceNetworkControllerPort({ requireCurrentBinding(cleanup) { guards.push(cleanup); if (!current) throw Error('foreign local binding'); }, invoke() { calls++; throw Error('must not dispatch'); } });
    await assert.rejects(port.close(), /foreign local binding/); current = true;
    await port.close(); await port.close(); assert.equal(calls, 0); assert(guards.every(cleanup => cleanup === true));
});
test('synchronous unknown request delivery still requires a real Main cleanup acknowledgement', async () => {
    const { createWorkspaceNetworkControllerPort } = await loaded, calls = [];
    const port = createWorkspaceNetworkControllerPort({ requireCurrentBinding() {}, invoke(value) { calls.push(value.action); if (value.action === 'request') throw Error('unknown delivery'); return Promise.resolve({ ok: true, closed: true }); } });
    await assert.rejects(port.request({ requestId: 'unknown' }, new AbortController().signal), /unknown delivery/);
    await port.close(); assert.deepEqual(calls, ['request', 'close']);
});
test('Main cancel ACK cannot falsely claim completion and channel loss cannot publish a result', async () => {
    const { createWorkspaceNetworkControllerPort } = await loaded, gate = deferred(), abort = new AbortController(); let current = true;
    const port = createWorkspaceNetworkControllerPort({ requireCurrentBinding(cleanup) { if (!cleanup && !current) throw Error('binding replaced'); }, invoke: async value => value.action === 'request' ? gate.promise : value.action === 'cancel' ? { ok: true, completionConfirmed: true } : { ok: true, closed: true } });
    const pending = port.request({ requestId: 'pending' }, abort.signal); abort.abort(); gate.resolve({ late: true }); await assert.rejects(pending, /cancellation delivery/);
    current = false; await assert.rejects(port.request({ requestId: 'new' }, new AbortController().signal), /binding replaced/); await port.close();
});
