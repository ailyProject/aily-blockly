'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SubappBrowserOwnerBridge, TYPES, validateParentMessage, validateRuntimeMessage } = require('./subapp-browser-owner-bridge');
const tick = () => new Promise(resolve => setImmediate(resolve));
function binding() { return { streamId: 'registered-stream', executionId: randomUUID(), bindingId: randomUUID(),
    packageName: '@fixture/generic', packageVersion: '1.2.3', owner: { sessionId: 'chat-a', ownerPid: process.pid, leaseFile: 'C:/owned/lease.json' } }; }
function reply(frame, ok = true) { return { type: frame.type === TYPES.bind ? TYPES.bound : TYPES.acknowledged,
    version: 1, requestId: frame.requestId, streamId: frame.streamId, executionId: frame.executionId,
    bindingId: frame.bindingId, sessionId: frame.owner.sessionId, ...(frame.releaseId ? { releaseId: frame.releaseId } : {}), ok,
    ...(!ok ? { errorCode: 'CONTROLLED_FAILURE', error: 'Retry the actual owner record' } : {}) }; }

test('private owner schema is strict, bounded, captured and never includes lease secrets in acknowledgements', () => {
    const frame = { ...binding(), type: TYPES.bind, version: 1, requestId: randomUUID() }, captured = validateParentMessage(frame);
    frame.owner.sessionId = 'changed'; assert.equal(captured.owner.sessionId, 'chat-a');
    const ack = reply(captured); assert.deepEqual(validateRuntimeMessage(ack), ack);
    for (const changed of [{ ...captured, token: 'x' }, { ...captured, bindingId: captured.bindingId.toUpperCase() },
        { ...captured, owner: { ...captured.owner, ownerPid: 0 } }, { ...captured, owner: { ...captured.owner, leaseFile: 'x'.repeat(4097) } }]) assert.throws(() => validateParentMessage(changed));
    assert.throws(() => validateRuntimeMessage({ ...ack, leaseFile: 'private' }));
});

test('Node binding awaits both the exact private ACK and the actual send callback; timeout retains the same I/O for retry', async () => {
    const actual = binding(), sent = [], sendGate = Promise.withResolvers(); let bridge;
    bridge = new SubappBrowserOwnerBridge({ timeoutMs: 100, resolveRuntime: () => ({ messagePort: { maxMessageBytes: 32768 },
        hostInfo: { runtimeConfig: { packageName: actual.packageName, version: actual.packageVersion } } }),
        send: async (stream, frame) => { sent.push(frame); bridge.handle(stream, reply(frame)); await sendGate.promise; return { success: true }; } });
    const first = bridge.bind(actual); await tick(); assert.equal(bridge.pendingCount, 1);
    await assert.rejects(first, /deadline/); assert.equal(bridge.pendingCount, 1);
    const retry = bridge.bind(actual); await tick(); assert.equal(sent.length, 1); sendGate.resolve();
    await retry; assert.equal(bridge.pendingCount, 0); assert.equal(actual.nodeBound, true);
});

test('failed or lost evidence is retryable with the original binding and release identity and does not acknowledge another owner', async () => {
    const actual = binding(), frames = []; let fail = true, bridge;
    bridge = new SubappBrowserOwnerBridge({ timeoutMs: 100, resolveRuntime: () => ({ messagePort: { maxMessageBytes: 32768 },
        hostInfo: { runtimeConfig: { packageName: actual.packageName, version: actual.packageVersion } } }),
        send: async (stream, frame) => { frames.push(frame); bridge.handle(stream, { ...reply(frame), sessionId: 'foreign' });
            queueMicrotask(() => bridge.handle(stream, reply(frame, frame.type === TYPES.bind || !fail))); return { success: true }; } });
    await bridge.bind(actual);
    actual.releaseId = randomUUID();
    await assert.rejects(bridge.released(actual), /Retry/); assert.equal(actual.nodeEvidenceAcknowledged, undefined);
    fail = false; await bridge.released(actual);
    assert.equal(actual.nodeEvidenceAcknowledged, true);
    assert.equal(frames[1].bindingId, frames[2].bindingId); assert.equal(frames[1].releaseId, frames[2].releaseId);
    assert.equal(bridge.pendingCount, 0);
});

test('a lost binding ACK retains bounded I/O and retries the exact request rather than minting another identity', async () => {
    const actual = binding(), frames = []; let bridge;
    bridge = new SubappBrowserOwnerBridge({ timeoutMs: 100, resolveRuntime: () => ({ messagePort: { maxMessageBytes: 32768 },
        hostInfo: { runtimeConfig: { packageName: actual.packageName, version: actual.packageVersion } } }),
        send: async (stream, frame) => { frames.push(frame); if (frames.length === 2) bridge.handle(stream, reply(frame)); return { success: true }; } });
    await assert.rejects(bridge.bind(actual), /deadline/); assert.equal(bridge.pendingCount, 1);
    await bridge.bind(actual); assert.equal(bridge.pendingCount, 0);
    assert.deepEqual(frames[0], frames[1]); assert.equal(actual.nodeBound, true);
});
