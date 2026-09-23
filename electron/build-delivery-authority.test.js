'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createBuildDeliveryAuthority } = require('./build-delivery-authority');

const { fixture } = require('./test/fixtures/build-delivery-fixture.cjs');
for (const coder of [false, true]) test(`only an observed successful ${coder ? 'Coder' : 'Blockly'} build can report a current source boundary`, async t => {
    const f = fixture(t, coder), handle = await f.api.begin(f.sender, f.options);
    assert.equal((await f.query()).status, 'running'); f.publish(handle);
    assert.equal((await f.query()).status, 'running'); handle.onExit(0, null, false);
    const result = await f.query(); assert.equal(result.status, 'source-current'); assert.equal(result.currentProjectAcceptance, false);
    assert.equal(result.authority, 'host-observed-build'); assert.equal(result.handle, handle.handle);
    f.put('package.json', { type: coder ? 'coder' : 'blockly', entry: 'src/main.cpp', buildInfo: { status: 'success' }, codeHash: 'result' });
    assert.equal((await f.query()).status, 'source-current', 'Result metadata must not stale the source');
    const restarted = createBuildDeliveryAuthority(f.dependencies);
    await assert.rejects(restarted.query(f.sender, { projectPath: f.root, handle: handle.handle }), /No matching/);
});

test('foreign owners, wrong handles and unsupervised launch shapes cannot mint authority', async t => {
    const f = fixture(t);
    await assert.rejects(f.api.begin({ isDestroyed: () => false }, f.options), /main renderer/);
    for (const patch of [{ shellProfile: true }, { appDataResourceToken: undefined }, { appDataResourceMode: 'write' },
        { args: [f.options.args[0], f.request, 'extra'] }]) await assert.rejects(f.api.begin(f.sender, { ...f.options, ...patch }), /supervised/);
    const handle = await f.api.begin(f.sender, f.options); f.publish(handle); handle.onExit(0, null, false);
    await assert.rejects(f.api.query(f.sender, { projectPath: f.root, handle: 'copied-from-another-host' }), /No matching/);
});

for (const binding of [undefined, 'f'.repeat(64)]) test(`missing/wrong private context process binding cannot mint authority: ${binding === undefined ? 'missing' : 'wrong'}`, async t => {
    const f = fixture(t), handle = await f.api.begin(f.sender, f.options);
    f.publish(handle, { inputContextSha256: binding }); handle.onExit(0, null, false);
    assert.equal((await f.query()).status, 'failed');
});

test('private context replacement invalidates an observed build even if the portable artifact stays identical', async t => {
    const f = fixture(t), handle = await f.api.begin(f.sender, f.options);
    f.publish(handle); handle.onExit(0, null, false);
    const filename = require('node:path').join(f.root, '.build/aily-build-input-context.json');
    require('node:fs').appendFileSync(filename, ' ');
    await assert.rejects(f.query(), /Input context changed/);
});

for (const outcome of ['failed', 'cancelled', 'signal', 'no-message', 'wrong-request', 'wrong-build', 'duplicate']) {
    test(`${outcome} cannot become a completed delivery`, async t => {
        const f = fixture(t), handle = await f.api.begin(f.sender, f.options);
        if (outcome !== 'no-message') f.publish(handle, outcome === 'wrong-request' ? { requestDigest: '0'.repeat(64) }
            : outcome === 'wrong-build' ? { buildId: randomUUID() } : {});
        if (outcome === 'duplicate') f.publish(handle);
        handle.onExit(outcome === 'failed' ? 1 : 0, outcome === 'signal' ? 'SIGTERM' : null, outcome === 'cancelled');
        assert.equal((await f.query()).status, 'failed');
    });
}

for (const change of ['workspace', 'runtime', 'board', 'activation', 'generation', 'manifest', 'library', 'receipt', 'artifact', 'new-build']) {
    test(`consumption rejects ${change} drift`, async t => {
        const f = fixture(t), handle = await f.api.begin(f.sender, f.options); f.publish(handle); handle.onExit(0, null, false);
        if (change === 'workspace') f.state.source.workspace = { ...f.state.source.workspace, documentSha256: '1'.repeat(64) };
        if (change === 'runtime') f.state.source.workspace = { ...f.state.source.workspace, runtimeRevision: 99 };
        if (change === 'board') f.state.source.boardModule = '@aily-project/board-other';
        if (change === 'activation') f.state.source.activationId = randomUUID();
        if (change === 'generation') f.state.owner.generation++;
        if (change === 'manifest') f.put('package.json', { type: 'blockly', entry: 'other.cpp' });
        if (change === 'library') f.put('libraries/local.h', '#define VALUE 2');
        if (change === 'receipt') f.put('.build/aily-build-delivery.json', '{}');
        if (change === 'artifact') f.put('.build/aily-artifact-manifest.json', '{}');
        if (change === 'new-build') f.api.invalidate(f.root);
        await assert.rejects(f.query());
    });
}

test('source changes during the awaited live query are rejected, not just changes before it', async t => {
    const f = fixture(t), handle = await f.api.begin(f.sender, f.options); f.publish(handle); handle.onExit(0, null, false);
    f.state.query = async () => { f.put('src/user.h', 'changed'); return { ok: true, source: f.state.source }; };
    await assert.rejects(f.query(), /changed/);
});

test('result metadata publication during a live query does not invalidate unchanged source', async t => {
    const f = fixture(t), handle = await f.api.begin(f.sender, f.options); f.publish(handle); handle.onExit(0, null, false);
    f.state.query = async () => {
        f.put('package.json', { type: 'blockly', entry: 'src/main.cpp', codeHash: 'result', buildInfo: { status: 'success' } });
        return { ok: true, source: f.state.source };
    };
    assert.equal((await f.query()).status, 'source-current');
});

test('unsaved Coder state refuses both registration and later consumption', async t => {
    const f = fixture(t, true); f.state.source.saved = false;
    await assert.rejects(f.api.begin(f.sender, f.options), /unsaved/);
    f.state.source.saved = true;
    const handle = await f.api.begin(f.sender, f.options); f.publish(handle); handle.onExit(0, null, false);
    f.state.source.saved = false; await assert.rejects(f.query(), /unsaved/);
});

test('a renderer reload during registration abandons its pending entry', async t => {
    const f = fixture(t);
    f.state.query = async () => { f.state.owner.generation++; return { ok: true, source: f.state.source }; };
    await assert.rejects(f.api.begin(f.sender, f.options), /generation/);
    await assert.rejects(f.query(), /No matching/);
});
