'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createBuildDeliveryAuthority } = require('./build-delivery-authority');
const { fixture } = require('./test/fixtures/build-delivery-fixture.cjs');
const { PROFILE, PROVIDER, QUERY, RESULT, queryCompilationProfile } = require('../child/scripts/simulation-transport-profile');
const { captureProjectSources, publishBuildDelivery } = require('../child/scripts/compile-delivery');
const { createLibraryProjectionRecorder } = require('../child/scripts/library-source-evidence');
const hash = value => createHash('sha256').update(value).digest('hex');

async function supervised(t, { binding = true, explicit = false } = {}) {
    const f = fixture(t); f.config.simulationDebug = true;
    if (explicit) f.config.simulationTransportProfile = PROFILE;
    fs.writeFileSync(f.request, JSON.stringify(f.config));
    let valid = true, selected = binding, captures = 0;
    const original = Object.freeze({ profile: PROFILE, provider: PROVIDER, assertCurrent() {
        if (!valid) throw new Error('original Browser owner ended');
    } });
    const api = createBuildDeliveryAuthority({ ...f.dependencies, captureCompilationBinding(sender) {
        assert.equal(sender, f.sender); captures++; return selected ? original : null;
    } });
    const handle = await api.begin(f.sender, f.options);
    const ipc = new EventEmitter(); ipc.connected = true;
    ipc.send = (message, done) => { const reply = handle.onMessage(message); done();
        queueMicrotask(() => ipc.emit('message', reply)); };
    const query = phase => queryCompilationProfile(f.config, phase, ipc, 100);
    const publish = (spp = false) => {
        const source = f.put('.temp/sketch/sketch.ino', f.config.code), before = captureProjectSources(f.config);
        const libraries = createLibraryProjectionRecorder().snapshot(f.config);
        f.put('.build/aily-library-projections.json', libraries);
        const graph = `aily_sketch_inputs_digest = ${f.config.sourceCapture.sketchInputs.digest}\n`;
        f.put('.build/build.ninja', graph);
        const body = { schemaVersion: 1, kind: 'aily-build-input-record', scope: 'build-graph-facts', configurationSha256: 'c'.repeat(64),
            steps: [{ kind: 'ninja-plan', name: 'linking', sha256: hash(graph) }] };
        const record = { ...body, digest: hash(JSON.stringify(body)) }, inputBytes = JSON.stringify(record);
        f.put('.build/aily-build-inputs.json', inputBytes);
        const inputs = { schemaVersion: 1, kind: 'aily-build-input-reference', scope: 'build-graph-facts', path: 'aily-build-inputs.json', digest: record.digest };
        f.put('.build/firmware.bin', 'synthetic firmware');
        f.put('.build/aily-artifact-manifest.json', { schemaVersion: 1, kind: 'aily-build-artifact', artifactId: 'a'.repeat(64),
            target: { fqbn: 'esp32:esp32:esp32' }, build: { source: { sha256: hash(f.config.code), sizeBytes: Buffer.byteLength(f.config.code) }, inputs,
                ...(spp ? { simulationProviders: [PROVIDER] } : {}) },
            files: [{ path: 'firmware.bin', role: 'application', sizeBytes: Buffer.byteLength('synthetic firmware'), sha256: hash('synthetic firmware') },
                { path: 'aily-build-inputs.json', role: 'build-inputs', sizeBytes: Buffer.byteLength(inputBytes), sha256: hash(inputBytes) }] });
        const receipt = publishBuildDelivery(f.config, before, source, 'esp32:esp32:esp32', libraries);
        handle.onMessage({ type: 'aily.build.delivery', requestDigest: hash(JSON.stringify(f.config)), buildId: receipt.buildId,
            inputRecordSha256: hash(inputBytes), receiptSha256: hash(fs.readFileSync(path.join(f.root, '.build/aily-build-delivery.json'))) });
    };
    return { ...f, api, handle, ipc, query, publish, publishSpp: () => publish(true), captures: () => captures,
        revoke() { valid = false; }, selectSuccessor() { selected = true; } };
}

test('supervised normal build IPC binds both phases and the actual Artifact provider to its original capture', async t => {
    const f = await supervised(t);
    assert.equal(await f.query('before-compile'), PROFILE);
    assert.equal(await f.query('before-delivery'), PROFILE);
    assert.equal(f.captures(), 1, 'Never resolve a successor binding for later phases.');
    f.publishSpp(); f.handle.onExit(0, null, false);
    assert.equal((await f.api.query(f.sender, { projectPath: f.root })).status, 'source-current');
    f.revoke(); await assert.rejects(f.api.query(f.sender, { projectPath: f.root }), /original Browser owner/);
});

test('old/unbound package stays unbound even if a new owner becomes available at the same path', async t => {
    const f = await supervised(t, { binding: false }); f.selectSuccessor();
    assert.equal(await f.query('before-compile'), null); assert.equal(await f.query('before-delivery'), null);
    f.publish(); f.handle.onExit(0, null, false);
    assert.equal((await f.api.query(f.sender, { projectPath: f.root })).status, 'source-current');
    assert.equal(f.captures(), 1);
});

test('owner release while awaiting the live project query cannot yield a current SPP delivery', async t => {
    const f = await supervised(t);
    await f.query('before-compile'); await f.query('before-delivery'); f.publishSpp(); f.handle.onExit(0, null, false);
    f.state.query = async () => { f.revoke(); return { ok: true, source: f.state.source }; };
    await assert.rejects(f.api.query(f.sender, { projectPath: f.root }), /original Browser owner/);
});

test('explicit project enum without a trusted current binding is rejected before launch', async t => {
    await assert.rejects(supervised(t, { binding: false, explicit: true }), /no current execution binding/);
});

for (const variant of ['owner-ended-before-compile', 'owner-ended-before-delivery', 'owner-ended-before-receipt',
    'duplicate-phase', 'wrong-digest', 'owner-selector', 'missing-confirmation', 'unbound-artifact', 'wrong-provider']) {
    test(`supervised profile permission rejects ${variant} without a successful delivery`, async t => {
        const f = await supervised(t, { binding: variant !== 'unbound-artifact' });
        if (variant === 'owner-ended-before-compile') { f.revoke(); await assert.rejects(f.query('before-compile'), /UNAVAILABLE/); }
        else if (variant === 'wrong-digest' || variant === 'owner-selector') {
            const message = { type: QUERY, requestDigest: hash(JSON.stringify(f.config)), phase: 'before-compile',
                ...(variant === 'wrong-digest' ? { requestDigest: '0'.repeat(64) } : { ownerId: 42 }) };
            assert.equal(f.handle.onMessage(message).ok, false);
        } else {
            assert.equal(await f.query('before-compile'), variant === 'unbound-artifact' ? null : PROFILE);
            if (variant === 'owner-ended-before-delivery') { f.revoke(); await assert.rejects(f.query('before-delivery'), /UNAVAILABLE/); }
            else if (variant === 'duplicate-phase') await assert.rejects(f.query('before-compile'), /UNAVAILABLE/);
            else if (variant !== 'missing-confirmation') {
                await f.query('before-delivery');
                if (variant === 'owner-ended-before-receipt') f.revoke();
            }
        }
        if (variant === 'wrong-provider') f.publish();
        else f.publishSpp();
        f.handle.onExit(0, null, false);
        assert.equal((await f.api.query(f.sender, { projectPath: f.root })).status, 'failed');
        assert.equal(f.ipc.listenerCount('message'), 0);
    });
}

test('private profile response has no package, owner, URL, release or payload selector', async t => {
    const f = await supervised(t);
    const reply = f.handle.onMessage({ type: QUERY, requestDigest: hash(JSON.stringify(f.config)), phase: 'before-compile' });
    assert.deepEqual(reply, { type: RESULT, requestDigest: hash(JSON.stringify(f.config)), phase: 'before-compile', ok: true, profile: PROFILE });
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 512);
    assert.equal(require('./simulator-compilation-profile').PROFILE, PROFILE);
    assert.equal(require('./simulator-compilation-profile').PROVIDER, PROVIDER);
});
