'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { SubappOwnerSupervisor } = require('../../electron/subapp-owner-supervisor');

function fixture(send = async () => {}) {
    let now = 1000, pid = 100;
    const contents = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, getOSProcessId: () => pid });
    const calls = [];
    const runtime = { streamId: 'controlled-runtime', hostInfo: { wsUrl: 'ws://127.0.0.1:4010/ws',
        runtimeConfig: { agent: { lifecycle: { ownerRelease: { method: 'fixture.owner.release' } } } } } };
    const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => runtime, now: () => now,
        send: async binding => { calls.push(binding); return send(binding); } });
    const generation = supervisor.connect(contents).generation;
    const acquired = supervisor.acquireAgentOwner(contents, { generation, sessionId: 'chat-1' });
    const input = { generation, ownerLeaseId: acquired.ownerLeaseId, sessionId: acquired.sessionId, ownerControl: acquired.ownerControl };
    return { supervisor, contents, runtime, calls, acquired, input,
        expire: () => { now += 46_000; }, changePid: () => { pid++; },
        recover: (extra = {}) => supervisor.recoverAgentOwner(contents, { ...input, recoveryRequestId: randomUUID(), pendingRequests: 0, rendererCleanupConfirmed: true, ...extra }),
        track: () => supervisor.track(contents, { generation, ownerSessionId: acquired.ownerLeaseId, toolId: 'fixture' }) };
}

test('main-issued private owner control is scope-bound and cannot retire an active owner', async () => {
    const f = fixture(); await f.track();
    assert.match(f.acquired.ownerControl.capability, /^owner-control-[a-f0-9-]{36}$/);
    await assert.rejects(f.recover(), { code: 'SUBAPP_OWNER_ACTIVE' });
    assert.equal(f.calls.length, 0);
    assert.equal(f.supervisor.inspectAgentOwner(f.contents, f.input).state, 'active');
});

test('expired owner recovery joins actual resources and reuses its one successor after a lost ACK', async () => {
    const f = fixture(); await f.track(); f.expire();
    const requestId = randomUUID();
    const first = await f.recover({ recoveryRequestId: requestId });
    const duplicate = await f.recover({ recoveryRequestId: requestId });
    assert.equal(first.ok, true); assert.equal(first.cleanup, 'confirmed');
    assert.notEqual(first.ownerLeaseId, f.acquired.ownerLeaseId);
    assert.notEqual(first.ownerControl.capability, f.acquired.ownerControl.capability);
    assert.deepEqual(duplicate.ownerControl, first.ownerControl);
    assert.deepEqual(duplicate.recoveryReceipt, first.recoveryReceipt);
    assert.equal(f.calls.length, 1); assert.equal(f.supervisor.agentOwners.size, 2);
});

test('failed cleanup retains its exact resource target and explicit same-nonce recovery really retries it', async () => {
    let broken = true;
    const f = fixture(async () => { if (broken) throw Error('transient cleanup failure'); });
    await f.track(); f.expire(); const requestId = randomUUID();
    await assert.rejects(f.recover({ recoveryRequestId: requestId }), { code: 'SUBAPP_OWNER_CLEANUP_FAILED' });
    assert.equal(f.supervisor.inspectAgentOwner(f.contents, f.input).cleanup, 'failed');
    assert.equal(f.supervisor.renderers.get(f.contents.id).bindings.size, 1);
    assert.equal(f.supervisor.agentOwners.size, 1);
    broken = false;
    const recovered = await f.recover({ recoveryRequestId: requestId });
    assert.equal(recovered.ok, true); assert.equal(f.calls.length, 2);
    assert.equal(f.supervisor.renderers.get(f.contents.id).bindings.size, 0);
});

test('native pending cleanup fences late resources and concurrent recovery still creates only one successor', async () => {
    const f = fixture(); f.runtime.nativeOwnerControl = true;
    await f.track();
    const guard = f.supervisor.createOwnerGuard(f.contents, { generation: f.input.generation,
        ownerSessionId: f.acquired.ownerLeaseId, toolId: 'fixture' });
    const cleanup = Promise.withResolvers(); let count = 0;
    guard.attachCleanup(async () => { count++; await cleanup.promise; });
    f.expire(); const requestId = randomUUID();
    const first = f.recover({ recoveryRequestId: requestId });
    const second = f.recover({ recoveryRequestId: requestId });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.supervisor.inspectAgentOwner(f.contents, f.input).state, 'retiring');
    await assert.rejects(f.track(), { code: 'SUBAPP_OWNER_EXPIRED' });
    assert.equal(f.supervisor.agentOwners.size, 1); assert.equal(count, 1);
    cleanup.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.ownerLeaseId, b.ownerLeaseId); assert.equal(f.supervisor.agentOwners.size, 2);
    assert.equal(f.calls.length, 0);
});

test('wrong capability, session, renderer incarnation and unknown issuance never grant retirement', async () => {
    const f = fixture(); await f.track(); f.expire();
    for (const extra of [
        { ownerControl: { ...f.input.ownerControl, capability: `owner-control-${randomUUID()}` } },
        { sessionId: 'another-chat' },
        { ownerLeaseId: `owner-${randomUUID()}` },
        { ownerControl: { ...f.input.ownerControl, generation: randomUUID() } },
    ]) await assert.rejects(f.recover(extra), { code: 'SUBAPP_OWNER_CONTROL_INVALID' });
    f.changePid(); await assert.rejects(f.recover(), { code: 'SUBAPP_OWNER_CONTROL_INVALID' });
    assert.equal(f.calls.length, 0); assert.equal(f.supervisor.agentOwners.size, 1);
});

test('historical owner credentials cannot release a newer owner while old cleanup is pending', async () => {
    const pending = Promise.withResolvers(); const f = fixture(() => pending.promise);
    await f.track(); f.expire();
    const original = f.recover();
    const rejected = assert.rejects(original, { code: 'SUBAPP_OWNER_SUPERSEDED' });
    await new Promise(resolve => setImmediate(resolve));
    const newer = f.supervisor.acquireAgentOwner(f.contents, { generation: f.input.generation, sessionId: 'chat-1' });
    pending.resolve(); await rejected;
    assert.equal(f.supervisor.agentOwners.size, 2);
    assert.equal(f.supervisor.agentOwners.get(newer.ownerLeaseId).state, 'active');
    assert.equal(f.calls.length, 1);
});

test('pending renderer requests or unconfirmed renderer cleanup block a successor despite Runtime cleanup', async () => {
    const f = fixture(); await f.track(); f.expire(); const requestId = randomUUID();
    await assert.rejects(f.recover({ recoveryRequestId: requestId, pendingRequests: 1 }), { code: 'SUBAPP_OWNER_PENDING_REQUESTS' });
    await assert.rejects(f.recover({ recoveryRequestId: requestId, rendererCleanupConfirmed: false }), { code: 'SUBAPP_OWNER_CLEANUP_FAILED' });
    assert.equal(f.supervisor.agentOwners.size, 1); assert.equal(f.calls.length, 1);
    assert.equal((await f.recover({ recoveryRequestId: requestId })).ok, true);
});

test('expired successor receipts identify only that successor and never mint a further incarnation', async () => {
    const f = fixture(); f.expire(); const requestId = randomUUID();
    const first = await f.recover({ recoveryRequestId: requestId }); f.expire();
    const replay = await f.recover({ recoveryRequestId: requestId });
    assert.equal(replay.ok, false); assert.equal(replay.errorCode, 'SUBAPP_OWNER_RECOVERY_RECEIPT_EXPIRED');
    assert.equal(replay.ownerLeaseId, first.ownerLeaseId); assert.equal(f.supervisor.agentOwners.size, 2);
    await assert.rejects(f.recover(), { code: 'SUBAPP_OWNER_RECOVERY_REQUEST_MISMATCH' });
});

test('legacy UUID-prefixed owners still track and clean without inventing main-process issuance evidence', async () => {
    const f = fixture(), legacy = `owner-${randomUUID()}`;
    const input = { generation: f.input.generation, ownerSessionId: legacy, toolId: 'fixture' };
    await f.supervisor.track(f.contents, input);
    const guard = f.supervisor.createOwnerGuard(f.contents, input); guard();
    assert.equal(f.supervisor.agentOwners.has(legacy), false);
    assert.equal((await f.supervisor.release(f.contents, input)).ok, true);
    assert.equal(f.calls.length, 1);
    assert.throws(guard, { code: 'SUBAPP_OWNER_EXPIRED' });
});
