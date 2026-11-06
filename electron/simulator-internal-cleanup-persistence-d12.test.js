'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSimulatorOwnerCleanupDiagnostics } = require('./simulator-owner-cleanup-diagnostics');
const PREFIX = 'AILY_INTERNAL_CLEANUP_V1 ';
const node = () => ({ source: 'node-handler-cleanup', parent: null, depth: 0, via: 'root', name: 'Error', code: null, category: 'unclassified' });
const diagnostic = () => ({ schemaVersion: 1, kind: 'aily-internal-cleanup-diagnostic', phase: 'node-view-detach', truncated: false, nodes: [node()] });
const observation = () => ({ schemaVersion: 1, kind: 'aily-internal-cleanup-observation', source: 'node-handler-close', status: 'rejected', stage: 'local-connections', serial: 'returned', network: 'entered' });
const line = value => Buffer.from(PREFIX + JSON.stringify(value) + '\n');
function decode(bytes, chunks) { const seen = []; const owner = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write: value => seen.push(value) });
    if (chunks) for (let at = 0; at < bytes.length; at += chunks) owner.push(bytes.subarray(at, at + chunks)); else owner.push(bytes);
    owner.close(); return seen; }

test('D12 private tree and stage DTOs persist reconstructed JSON with exact enums', () => {
    const a = diagnostic(), b = observation(); a.nodes[0].code = 'cleanup-unconfirmed'; a.nodes[0].category = 'guest-mapping-cleanup-unconfirmed';
    assert.deepEqual(decode(Buffer.concat([line(a), line(b)])), [a, b]);
});
test('D12 byte-stream split, CRLF, multiple frames and final tail remain bounded and complete', () => {
    const a = diagnostic(), b = observation(), bytes = Buffer.from(PREFIX + JSON.stringify(a) + '\r\n' + PREFIX + JSON.stringify(b));
    for (const chunk of [1, 7, 31, 1023]) assert.deepEqual(decode(bytes, chunk), [a, b]);
});
test('D12 actual current Gateway D6/D9 formatter output reaches Main unchanged safe DTOs', { skip: !process.env.AILY_NETWORK_TEST_PROTOCOL_ROOT }, async () => {
    const root = path.resolve(process.env.AILY_NETWORK_TEST_PROTOCOL_ROOT);
    const api = await import(pathToFileURL(path.join(root, 'packages/simulator-gateway/dist/internal-cleanup-diagnostic.js')).href);
    const e = new AggregateError([Object.assign(new Error('Node control cleanup deadline exceeded'), { code: 'cleanup-unconfirmed' })], 'Node control handler cleanup is unconfirmed');
    const a = api.createInternalCleanupDiagnostic('node-view-detach', [{ source: 'node-handler-cleanup', error: e }]);
    const b = api.createInternalCleanupObservation({ source: 'node-handler-close', status: 'rejected', stage: 'local-connections', serial: 'returned', network: 'entered' });
    assert.equal(typeof a, 'string'); assert.equal(typeof b, 'string');
    const seen = [], owner = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write: value => seen.push(value) });
    const sink = text => owner.push(Buffer.from(text));
    api.emitInternalCleanupDiagnostic('node-view-detach', [{ source: 'node-handler-cleanup', error: e }], sink);
    api.emitInternalCleanupObservation({ source: 'node-handler-close', status: 'rejected', stage: 'local-connections', serial: 'returned', network: 'entered' }, sink);
    owner.close();
    assert.deepEqual(seen, [JSON.parse(a.slice(PREFIX.length)), JSON.parse(b.slice(PREFIX.length))]);
});
test('D12 exact keys and enum mismatch reject every tree or observation frame', () => {
    const changes = [v => v.schemaVersion = 2, v => v.kind = 'unknown', v => v.phase = 'file:///sensitive',
        v => v.truncated = 'false', v => v.extra = 'raw-secret', v => v.nodes[0].source = 'unknown', v => v.nodes[0].name = 'secret',
        v => v.nodes[0].code = 'raw-token', v => v.nodes[0].category = 'http://endpoint', v => v.nodes[0].message = 'raw-payload',
        v => v.nodes[0].via = 'unknown', v => v.nodes[0].parent = 0, v => v.nodes[0].depth = 1, v => v.nodes = []];
    for (const change of changes) { const v = diagnostic(); change(v); assert.deepEqual(decode(line(v)), []); }
    for (const [key, value] of [['source', 'unknown'], ['status', 'raw-error'], ['stage', 'file-path'], ['serial', 1], ['network', true], ['extra', 'token']]) {
        const v = observation(); v[key] = value; assert.deepEqual(decode(line(v)), []);
    }
    assert.deepEqual(decode(Buffer.from(JSON.stringify(diagnostic()) + '\n')), []);
});
test('D12 tree parent source, index, depth and via relations are actual finite tree structure', () => {
    const good = diagnostic(); good.nodes[0].name = 'AggregateError'; good.nodes.push({ ...node(), parent: 0, depth: 1, via: 'aggregate' });
    assert.deepEqual(decode(line(good)), [good]);
    for (const change of [v => v.nodes[1].source = 'node-detach-result-send', v => v.nodes[1].parent = 1,
        v => v.nodes[1].parent = -1, v => v.nodes[1].parent = 0.5, v => v.nodes[1].depth = 2, v => v.nodes[1].via = 'root']) {
        const v = structuredClone(good); change(v); assert.deepEqual(decode(line(v)), []);
    }
});
test('D12 sixteen nodes and depth below four qualify; larger count or depth does not', () => {
    const good = diagnostic(); good.truncated = true; good.nodes = Array.from({ length: 16 }, node);
    assert.deepEqual(decode(line(good)), [good]); good.nodes.push(node()); assert.deepEqual(decode(line(good)), []);
    const deep = diagnostic(); for (let depth = 1; depth < 4; depth++) deep.nodes.push({ ...node(), parent: depth - 1, depth, via: 'cause' });
    assert.deepEqual(decode(line(deep)), [deep]); deep.nodes.push({ ...node(), parent: 3, depth: 4, via: 'cause' }); assert.deepEqual(decode(line(deep)), []);
});
test('D12 oversized or malformed line is dropped until newline without contaminating next original frame', () => {
    const valid = line(observation()); const oversized = Buffer.from(PREFIX + ' '.repeat(4096) + JSON.stringify(diagnostic()) + '\n');
    assert.deepEqual(decode(Buffer.concat([oversized, Buffer.from(PREFIX + '{bad}\n'), valid]), 29), [observation()]);
});
test('D12 legacy seven-stage branch keeps its original exact fields and original1024byte cap', () => {
    for (const stage of ['owner.scene-generation', 'owner.application', 'owner.workspace', 'application.control-sessions', 'application.tool-launches', 'application.artifact-reads', 'application.editor-locations']) {
        const v = { event: 'simulator-owner-cleanup-stage-failed', stage, errorCode: 'cleanup-unconfirmed' };
        assert.deepEqual(decode(Buffer.from(JSON.stringify(v) + '\n')), [v]);
        assert.deepEqual(decode(Buffer.from(JSON.stringify(v) + ' '.repeat(1025) + '\n')), []);
        assert.deepEqual(decode(Buffer.from(JSON.stringify({ ...v, message: 'raw' }) + '\n')), []);
    }
});
test('D12 all diagnostic scalars are fixed vocabulary and reconstruction adds no raw values', () => {
    const v = observation(); delete v.stage; delete v.serial; delete v.network; const a = decode(line(v)); assert.deepEqual(a, [v]);
    const b = diagnostic(); b.nodes[0].name = 'NonError'; b.nodes[0].category = 'node-control-cleanup-deadline';
    assert.deepEqual(decode(line(b)), [b]); assert.equal(JSON.stringify(decode(line(b))).includes('message'), false);
});
test('D12 disabled and closed owners never write later observations', () => {
    const seen = [], disabled = createSimulatorOwnerCleanupDiagnostics({ enabled: false, write: value => seen.push(value) });
    disabled.push(line(diagnostic())); disabled.close(); assert.deepEqual(seen, []);
    const closed = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write: value => seen.push(value) }); closed.close(); closed.close(); closed.push(line(observation())); assert.deepEqual(seen, []);
});
test('D12 synchronous failed sink cannot throw through push or close', () => {
    const owner = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write() { throw new Error('sink error never forwarded'); } });
    assert.doesNotThrow(() => owner.push(line(diagnostic()))); assert.doesNotThrow(() => owner.push(line(observation()))); assert.doesNotThrow(() => owner.close());
});
test('D12 async failed sink is never awaited, cannot become unhandled, and does not replace original records', async () => {
    const unhandled = [], listener = error => unhandled.push(error), seen = []; process.on('unhandledRejection', listener);
    try {
        const owner = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write(value) { seen.push(value); return Promise.reject(new Error('async sink')); } });
        assert.equal(owner.push(line(diagnostic())), undefined); assert.equal(owner.push(line(observation())), undefined); assert.equal(owner.close(), undefined);
        await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(unhandled, []); assert.deepEqual(seen, [diagnostic(), observation()]);
    } finally { process.removeListener('unhandledRejection', listener); }
});
