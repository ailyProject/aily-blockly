'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { PROFILE, PROVIDER, NATIVE_PROFILE, readCompilationProfiles, captureSimulatorCompilationBinding } = require('./simulator-compilation-profile');
const { readBrowserExecutionSource } = require('./subapp-browser-execution-source');
const { createConfiguredBrowserExecutionHost } = require('./subapp-browser-resource-config');
const { SubappBrowserProcessBroker } = require('./subapp-browser-process-broker');
const { SubappOwnerSupervisor } = require('./subapp-owner-supervisor');
const { acquireOwner } = require('./child-tool-session-leases');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const declaration = () => ({ schemaVersion: 1, profile: PROFILE, provider: PROVIDER,
    nativeProfile: NATIVE_PROFILE, runtimeAcceptance: false });

async function fixture(t, profiles = [declaration()]) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-spp-owner-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'public'));
    const entry = '<!doctype html><title>pinned execution</title>';
    fs.writeFileSync(path.join(root, 'public/execution.html'), entry);
    const browser = { protocol: 'aily-browser-execution-v1', root: 'public', entry: 'execution.html', sha256: hash(entry),
        ...(profiles === undefined ? {} : { compilationProfiles: profiles }) };
    const manifest = { name: '@fixture/simulator', version: '1.2.3', ailySubapp: { runtime: { browserExecution: browser } } };
    const save = () => fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest)); save();
    const config = { id: 'simulator', packagePath: root, packageName: manifest.name, version: manifest.version,
        agent: { lifecycle: { ownerRelease: { method: 'fixture.owner.release' } } } };
    const source = readBrowserExecutionSource(config);
    const publicManifest = { schemaVersion: 1, kind: 'aily-browser-resource-release',
        packageIdentity: { name: source.packageName, version: source.version },
        files: [{ path: source.entry, bytes: Buffer.byteLength(entry), sha256: source.sha256 }] };
    const releaseId = hash(JSON.stringify(publicManifest));
    const resourceBaseUrl = `https://resources.example/releases/${releaseId}/`;
    const configPath = path.join(root, 'resources.json');
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, kind: 'aily-subapp-browser-resource-config',
        releases: [{ resourceBaseUrl, releaseId, manifest: publicManifest }] }));
    const host = createConfiguredBrowserExecutionHost({ configurationFilePath: configPath });
    const runtime = { streamId: 'actual-runtime', hostInfo: { runtimeConfig: config, wsUrl: 'ws://127.0.0.1:54321/' },
        owners: new Map(), messagePort: { maxMessageBytes: 1024 * 1024 } };
    const sender = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false });
    const lease = { runtimeId: runtime.streamId, executionId: 'actual-execution', ownerId: sender.id, leaseId: 'original-lease' };
    const state = { source, executionId: lease.executionId, owners: new Map(), retiring: new Set(),
        resourceBaseUrl, resourceIdentity: releaseId, resourceSha256: { [source.entry]: source.sha256 } };
    acquireOwner(state, lease.ownerId, lease.leaseId); host.runtimes.set(runtime.streamId, state);
    let current = runtime;
    const resolveRuntime = (tool, owner) => tool === 'simulator' && owner === sender.id ? current : null;
    const supervisor = new SubappOwnerSupervisor({ resolveRuntime, send: async () => ({ ok: true }) });
    const { generation } = supervisor.connect(sender);
    const ownerInput = { generation, ownerSessionId: lease.leaseId, toolId: 'simulator' };
    await supervisor.track(sender, ownerInput);
    const guard = supervisor.createOwnerGuard(sender, ownerInput);
    const broker = new SubappBrowserProcessBroker({ host });
    const record = { key: 'original-record', lease, toolId: 'simulator', guard, connection: { connectionId: 'actual-connection' } };
    broker.owners.set(record.key, record); broker.connections.set(record.connection.connectionId, record);
    const registry = { host, broker, resolveRuntime };
    return { root, browser, source, config, manifest, save, configPath, state, host, record, runtime, sender, registry,
        replaceRuntime() { current = { ...runtime }; }, revoke: () => supervisor.release(sender, ownerInput) };
}

test('optional compilation metadata is exact, frozen, compilation-only and part of source identity', async t => {
    const f = await fixture(t), enabledIdentity = f.source.identity;
    assert.ok(Object.isFrozen(f.source.compilationProfiles)); assert.ok(Object.isFrozen(f.source.compilationProfiles[0]));
    delete f.browser.compilationProfiles; f.save();
    const old = readBrowserExecutionSource(f.config);
    assert.equal(old.compilationProfiles, undefined);
    assert.equal(old.identity, JSON.stringify([f.manifest.name, f.manifest.version, f.root, 'public', old.entry, old.sha256, {}]),
        'Absent metadata preserves the old source identity bytes.');
    assert.notEqual(old.identity, enabledIdentity);
    for (const value of [[], [declaration(), declaration()], [{ ...declaration(), runtimeAcceptance: true }],
        [{ ...declaration(), nativeProfile: 'other' }], [{ ...declaration(), extra: true }], [{ ...declaration(), provider: 'other' }]]) {
        assert.throws(() => readCompilationProfiles(value), /compilation profile/);
        f.browser.compilationProfiles = value; f.save(); assert.throws(() => readBrowserExecutionSource(f.config), /compilation profile/);
    }
});

test('real supervision runtime projection permits only its original registered physical stream', async t => {
    const f = await fixture(t);
    assert.notEqual(f.record.guard.runtime, f.runtime);
    assert.deepEqual(f.record.guard.runtime, { streamId: f.runtime.streamId, origin: 'ws://127.0.0.1:54321' });
    assert.ok(Object.isFrozen(f.record.guard.runtime));
    const binding = captureSimulatorCompilationBinding(f.registry, f.sender);
    assert.ok(binding, 'A real Supervisor guard projects runtime identity instead of sharing the registered session object.');
    assert.doesNotThrow(binding.assertCurrent);
    await f.revoke();
    assert.throws(binding.assertCurrent, /binding has ended/);
    assert.equal(captureSimulatorCompilationBinding(f.registry, f.sender), null);
    const mismatched = await fixture(t);
    mismatched.runtime.streamId = 'another-physical-stream';
    assert.equal(captureSimulatorCompilationBinding(mismatched.registry, mismatched.sender), null);
});

test('only actual registered owner + installed source + configured selected HTTPS release supplies permission', async t => {
    const f = await fixture(t), binding = captureSimulatorCompilationBinding(f.registry, f.sender);
    assert.equal(binding.profile, PROFILE); assert.equal(binding.provider, PROVIDER);
    assert.ok(Object.isFrozen(binding)); assert.doesNotThrow(binding.assertCurrent);
    assert.equal(captureSimulatorCompilationBinding(f.registry, { ...f.sender, id: 99 }), null);
    assert.equal(captureSimulatorCompilationBinding({ ...f.registry, broker: { resolveNetworkOwner: () => null } }, f.sender), null);
    const selected = f.host.configuredReleaseForSource(f.source);
    fs.writeFileSync(f.configPath, '{}');
    assert.equal(f.host.configuredReleaseForSource(f.source), selected, 'Permission uses the frozen normal Main configuration.');
});

for (const drift of ['old-package', 'installed-version', 'entry', 'metadata', 'unconfigured-release', 'release', 'base', 'entry-pin',
    'execution', 'runtime-successor', 'owner-successor', 'retiring', 'source-successor', 'revoked-owner']) {
    test(`original compilation binding refuses ${drift} drift and cannot follow a same-path successor`, async t => {
        const f = await fixture(t), binding = captureSimulatorCompilationBinding(f.registry, f.sender);
        assert.ok(binding);
        if (drift === 'old-package' || drift === 'metadata') { delete f.browser.compilationProfiles; f.save(); }
        if (drift === 'installed-version') { f.manifest.version = '9.0.0'; f.save(); }
        if (drift === 'entry') fs.appendFileSync(path.join(f.root, 'public/execution.html'), 'changed');
        if (drift === 'unconfigured-release') f.config.version = 'unknown';
        if (drift === 'release') f.state.resourceIdentity = '0'.repeat(64);
        if (drift === 'base') f.state.resourceBaseUrl = 'https://other.example/';
        if (drift === 'entry-pin') f.state.resourceSha256[f.source.entry] = '1'.repeat(64);
        if (drift === 'execution') f.state.executionId = 'successor';
        if (drift === 'runtime-successor') f.replaceRuntime();
        if (drift === 'owner-successor') {
            f.registry.broker.owners.set(f.record.key, { ...f.record });
        }
        if (drift === 'retiring') f.record.retiring = true;
        if (drift === 'source-successor') f.state.source = { ...f.source };
        if (drift === 'revoked-owner') await f.revoke();
        assert.throws(binding.assertCurrent);
        if (!['runtime-successor', 'source-successor', 'owner-successor'].includes(drift)) {
            assert.equal(captureSimulatorCompilationBinding(f.registry, f.sender), null);
        }
    });
}

test('ordinary packages without metadata never gain permission from a project claim', async t => {
    const f = await fixture(t); delete f.browser.compilationProfiles; f.save();
    f.state.source = readBrowserExecutionSource(f.config);
    assert.equal(captureSimulatorCompilationBinding(f.registry, f.sender, { simulationTransportProfile: PROFILE }), null);
});
