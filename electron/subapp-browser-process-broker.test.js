'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { SubappBrowserProcessBroker, REQUEST, RESULT, CANCEL } = require('./subapp-browser-process-broker');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { const end = Date.now() + 1000; while (!check()) { if (Date.now() > end) throw new Error('Controlled broker condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }
class Port extends EventEmitter {
    postMessage(data) { if (this.closed) throw new Error('Port closed'); queueMicrotask(() => { if (!this.peer.closed) this.peer.emit('message', { data }); }); }
    start() {} close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}
function harness(t, options = {}) {
    const sent = [], browser = [], guards = [], endpoints = [], streams = new Map(); let opens = 0, closes = 0;
    const host = {
        isCurrent: lease => !lease.dead,
        async connectRuntime(input) {
            opens++; await options.open?.();
            const port = new Port(), peer = new Port(); port.peer = peer; peer.peer = port;
            const endpoint = { connectionId: randomUUID(), executionId: input.executionId, port, peer,
                async close() { closes++; if (options.failClose?.()) throw new Error('Detach not acknowledged'); peer.close(); port.close(); input.onClosed(); } };
            peer.on('message', ({ data }) => browser.push({ endpoint, data })); endpoints.push(endpoint); return endpoint;
        },
    };
    const broker = new SubappBrowserProcessBroker({ host, send: async (streamId, message) => { sent.push({ streamId, message }); return { success: true }; },
        resolveStream: id => streams.get(id), cancelGraceMs: 20, ...options.budgets });
    function owner(streamId = 'node-a', ownerId = 1) {
        streams.set(streamId, { toolId: 'fixture', messagePort: { maxMessageBytes: 4096 } });
        let active = true; const cleanups = new Set(), lease = { runtimeId: streamId, executionId: randomUUID(), ownerId, leaseId: randomUUID() };
        const guard = () => { if (!active) throw new Error('Owner revoked'); };
        Object.assign(guard, { runtime: { streamId }, ownerSessionId: lease.leaseId,
            attachCleanup(cleanup) { guard(); cleanups.add(cleanup); return () => cleanups.delete(cleanup); } });
        const owned = { lease, guard, toolId: 'fixture', cleanups, async revoke() { active = false; for (const cleanup of [...cleanups]) { await cleanup(); cleanups.delete(cleanup); } } };
        guards.push(owned); return owned;
    }
    function request(connection, requestId = randomUUID(), payload = { operation: 'finite-fixture' }, extra = {}) {
        return { type: REQUEST, version: 1, runtimeId: connection.endpoint.runtimeId, connectionId: connection.connectionId, requestId, payload, ...extra };
    }
    function answer(endpoint, frame, outcome = { ok: true, result: { value: 'actual-result' } }) { endpoint.peer.postMessage({ ...frame, type: RESULT, ...outcome }); }
    t.after(async () => { for (const owned of guards) await owned.revoke().catch(() => {}); for (const endpoint of endpoints) { endpoint.peer.close(); endpoint.port.close(); } });
    return { broker, host, owner, request, answer, browser, sent, endpoints, get opens() { return opens; }, get closes() { return closes; } };
}

test('Node cannot mint an owner/connection, and unrelated messages retain existing routing', t => {
    const h = harness(t); h.owner();
    assert.equal(h.broker.handle('node-a', { type: 'other-provider-message' }), false);
    assert.equal(h.broker.handle('node-a', { type: REQUEST, version: 1, connectionId: randomUUID(), runtimeId: randomUUID(), requestId: 'probe', ownerSessionId: 'forged' }), true);
    assert.equal(h.sent[0].message.errorCode, 'BROWSER_EXECUTION_NOT_AUTHORIZED'); assert.equal(h.opens, 0); assert.equal(h.broker.owners.size, 0);
});

test('authorized binding is shared; requests/results stay pinned to owner, process and execution', async t => {
    const h = harness(t), a = h.owner(), b = h.owner('node-b', 2);
    const [one, same] = await Promise.all([h.broker.bind(a), h.broker.bind(a)]); assert.deepEqual(one, same); assert.equal(h.opens, 1);
    await h.broker.bind(b);
    const frame = h.request(one, 'request-one'); h.broker.handle('node-b', frame); assert.equal(h.sent.at(-1).message.errorCode, 'BROWSER_EXECUTION_NOT_AUTHORIZED');
    h.broker.handle('node-a', frame); await tick(); assert.equal(h.browser.length, 1);
    h.answer(h.endpoints[0], frame); await tick(); assert.equal(h.sent.at(-1).streamId, 'node-a'); assert.equal(h.sent.at(-1).message.result.value, 'actual-result');
    assert.equal(h.broker.pendingCount, 0); assert.equal(h.broker.pendingBytes, 0);
    await a.revoke(); assert.equal(h.broker.connections.size, 1); assert.equal(h.endpoints[1].port.closed, undefined);
});

test('cancel waits for a terminal execution reply instead of claiming that sending cancel stopped work', async t => {
    const h = harness(t), a = h.owner(), bound = await h.broker.bind(a), frame = h.request(bound);
    h.broker.handle('node-a', frame); h.broker.handle('node-a', { ...frame, type: CANCEL }); await tick();
    assert.deepEqual(h.browser.map(item => item.data.type), [REQUEST, CANCEL]); assert.equal(h.sent.length, 0); assert.equal(h.broker.pendingCount, 1);
    h.answer(h.endpoints[0], frame); await tick();
    assert.equal(h.sent[0].message.errorCode, 'BROWSER_EXECUTION_CANCELLED'); assert.equal(h.broker.pendingCount, 0); assert.equal(h.closes, 0);
});

test('request timeout sends bounded cancel and waits for the actual terminal reply', async t => {
    const h = harness(t), a = h.owner(), bound = await h.broker.bind(a), frame = h.request(bound, 'timed', {}, { timeoutMs: 100 });
    h.broker.handle('node-a', frame); await until(() => h.browser.some(item => item.data.type === CANCEL));
    assert.equal(h.sent.length, 0); h.answer(h.endpoints[0], frame); await tick();
    assert.equal(h.sent[0].message.errorCode, 'BROWSER_EXECUTION_TIMEOUT'); assert.equal(h.broker.pendingCount, 0);
});

for (const code of ['cleanup-unconfirmed', 'BROWSER_EXECUTION_CANCEL_UNCONFIRMED']) {
    for (const cancellation of ['abort', 'timeout']) test(`original ${code} survives local ${cancellation} projection`, async t => {
        const h = harness(t, { budgets: { cancelGraceMs: 1000 } }), a = h.owner(), bound = await h.broker.bind(a);
        const frame = h.request(bound, randomUUID(), {}, { timeoutMs: cancellation === 'timeout' ? 100 : 10000 });
        h.broker.handle('node-a', frame);
        if (cancellation === 'abort') h.broker.handle('node-a', { ...frame, type: CANCEL });
        await until(() => h.browser.some(item => item.data.type === CANCEL));
        assert.equal(h.sent.length, 0); assert.equal(h.broker.pendingCount, 1);
        h.answer(h.endpoints[0], frame, { ok: false, errorCode: code, error: 'Original cleanup remains unconfirmed' });
        await tick();
        assert.equal(h.sent[0].message.errorCode, code);
        assert.equal(h.sent[0].message.requestId, frame.requestId);
        assert.equal(h.sent[0].message.connectionId, frame.connectionId);
        assert.equal(h.broker.pendingCount, 0); assert.equal(h.closes, 0);
    });
}

test('unconfirmed cancellation retains cleanup and budget until a retry obtains detach ACK', async t => {
    let fail = true; const h = harness(t, { failClose: () => fail }), a = h.owner(), bound = await h.broker.bind(a), frame = h.request(bound);
    h.broker.handle('node-a', frame); h.broker.handle('node-a', { ...frame, type: CANCEL });
    await until(() => h.sent.some(item => item.message.errorCode === 'BROWSER_EXECUTION_CANCEL_UNCONFIRMED'));
    assert.equal(h.broker.pendingCount, 1); assert.equal(h.broker.connections.size, 1); assert.equal(a.cleanups.size, 1);
    const blocked = h.request(bound, 'late'); h.broker.handle('node-a', blocked); assert.equal(h.sent.at(-1).message.errorCode, 'BROWSER_EXECUTION_NOT_AUTHORIZED');
    fail = false; await a.revoke(); assert.equal(h.broker.pendingCount, 0); assert.equal(h.broker.pendingBytes, 0); assert.equal(h.broker.connections.size, 0);
    assert.equal(h.sent.filter(item => item.message.requestId === frame.requestId).length, 1, 'Unconfirmed outcome is never followed by a contradictory second terminal reply');
});

test('per-connection inflight, byte and JSON limits reject before domain port delivery', async t => {
    const h = harness(t), a = h.owner(), bound = await h.broker.bind(a), frames = [];
    for (let index = 0; index < 17; index++) { const frame = h.request(bound, 'request-' + index); frames.push(frame); h.broker.handle('node-a', frame); }
    await tick(); assert.equal(h.browser.length, 16); assert.equal(h.sent.at(-1).message.errorCode, 'BROWSER_EXECUTION_BUSY');
    h.broker.handle('node-a', h.request(bound, 'too-large', { data: 'x'.repeat(5000) }));
    h.broker.handle('node-a', h.request(bound, 'invalid', { data: undefined }));
    await tick(); assert.equal(h.browser.length, 16); assert.equal(h.sent.at(-1).message.errorCode, 'BROWSER_EXECUTION_INVALID_REQUEST');
    for (const frame of frames.slice(0, 16)) h.answer(h.endpoints[0], frame); await tick(); assert.equal(h.broker.pendingCount, 0);
});

test('duplicate request id fences the connection rather than replaying a mutation', async t => {
    const h = harness(t), a = h.owner(), bound = await h.broker.bind(a), frame = h.request(bound, 'unique');
    h.broker.handle('node-a', frame); await tick(); h.broker.handle('node-a', frame); await tick(); await tick();
    assert.equal(h.browser.filter(item => item.data.type === REQUEST).length, 1); assert.equal(h.broker.connections.size, 0); assert.equal(h.broker.pendingCount, 0);
});

test('an execution event or oversized result is never forwarded as a process event stream', async t => {
    const h = harness(t), a = h.owner(), bound = await h.broker.bind(a), frame = h.request(bound);
    h.broker.handle('node-a', frame); h.endpoints[0].peer.postMessage({ type: 'event', rawEdges: [1, 2, 3] }); await tick(); await tick();
    assert.equal(h.sent.some(item => item.message.type !== RESULT || item.message.rawEdges), false);
    assert.equal(h.broker.connections.size, 0); assert.equal(h.broker.pendingCount, 0);
});

test('owner revocation during held port attachment cannot publish a late Node capability', async t => {
    const gate = Promise.withResolvers(), h = harness(t, { open: () => gate.promise }), a = h.owner();
    const opening = h.broker.bind(a), rejected = assert.rejects(opening, /revoked|ended/);
    const revoke = a.revoke(); gate.resolve(); await Promise.all([rejected, revoke]);
    assert.equal(h.broker.owners.size, 0); assert.equal(h.broker.connections.size, 0); assert.equal(h.endpoints[0].port.closed, true);
});

test('a concurrent bind cannot hand out a retiring connection while detach is unconfirmed', async t => {
    let fail = true; const gate = Promise.withResolvers(), h = harness(t, { open: () => gate.promise, failClose: () => fail }), a = h.owner();
    const first = h.broker.bind(a), second = h.broker.bind(a);
    const firstFailure = assert.rejects(first, /ended|acknowledged/), secondFailure = assert.rejects(second, /ended/);
    const record = [...h.broker.owners.values()][0], revoking = assert.rejects(h.broker.revoke(record), /acknowledged/);
    gate.resolve(); await Promise.all([firstFailure, secondFailure, revoking]);
    assert.equal(record.retiring, true); assert.equal(record.closed, undefined);
    fail = false; await a.revoke(); assert.equal(h.broker.owners.size, 0);
});

test('signed authorization stays on the current registered-process Host lane and never enters an Agent domain port', async t => {
    const h = harness(t), a = h.owner(), bound = await h.broker.bind(a), calls = [];
    h.host.refreshRuntimeAuthorization = async input => { input.guard(); calls.push(input); return null; };
    const response = { configuration: { public: true }, lease: { signed: true }, revocations: { signed: true } };
    const frame = h.request(bound, 'signed-refresh', { method: 'authorization.refresh', response });
    h.broker.handle('foreign-process', frame); await tick(); assert.equal(calls.length, 0);
    h.broker.handle('node-a', frame); await tick();
    assert.equal(calls.length, 1); assert.equal(calls[0].connectionId, bound.connectionId);
    assert.deepEqual(calls[0].response, response); assert.equal(h.browser.length, 0);
    assert.equal(h.sent.at(-1).message.ok, true); assert.equal(h.sent.at(-1).message.result, null);
    assert.equal(h.sent.at(-1).message.response, undefined); assert.equal(h.broker.pendingCount, 0);
});

test('signed authorization verifier failure is explicit and cannot fall through to ordinary domain requests', async t => {
    const h = harness(t), a = h.owner(), bound = await h.broker.bind(a);
    h.host.refreshRuntimeAuthorization = async () => { throw Error('original verifier rejected'); };
    h.broker.handle('node-a', h.request(bound, 'bad-refresh', { method: 'authorization.refresh', response: {} }));
    await tick(); assert.equal(h.sent.at(-1).message.errorCode, 'BROWSER_EXECUTION_AUTHORIZATION_FAILED');
    assert.equal(h.browser.length, 0); assert.equal(h.broker.pendingCount, 0);
});
