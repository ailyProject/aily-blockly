'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createSubappManager, readInstalledState, validateIndex } = require('./subapp-manager');
const versions = require('./subapp-version-store');
const { acquireInstallLock } = require('./subapp-install-lock');
const { loadInstalledMainGattComposition } = require('./subapp-gatt-installed-backend');
const { createMainGattProviderOwner } = require('./subapp-gatt-provider-owner');
const providerModule = process.env.AILY_GATT_TEST_PROVIDER_MODULE ||
    '/Volumes/data/aily-work/work/w8-gatt-message-port-20261108-a01/main-module-a01/local-gatt-backend.cjs';
const originalNative = Module._extensions['.node'];
test.before(() => { Module._extensions['.node'] = () => assert.fail('Native addon loading is forbidden in this test'); });
test.after(() => { Module._extensions['.node'] = originalNative; });

function fixture(t) {
    const temporary = '/Volumes/data/aily-work/tmp/w8-gatt-composition-selection-20261108-a01';
    fs.mkdirSync(temporary, { recursive: true });
    const rootDir = fs.mkdtempSync(path.join(temporary, 'normal-manager-'));
    const entries = {}, roots = {}, selected = [];
    const specs = [
        ['aily-simulator', '@aily-project/aily-simulator', '0.1.0', 'localGattProvider', 'aily-local-gatt-provider', 'local-gatt-backend.cjs'],
        ['ble-debugger', '@aily-project/subapp-ble-debugger', '0.1.1', 'localGattBackend', 'aily-local-gatt-native-backend', 'host-gatt-native-backend.cjs'],
    ];
    for (const [id, name, version, declaration, kind, entry] of specs) {
        const catalog = { id, package: name, version, namespace: id.replaceAll('-', '_').toUpperCase(),
            titleKey: 'TEST.NAME', app: { name: id, enabled: true },
            dist: { tarball: `https://packages.example.test/${id}.tgz`, integrity: 'sha256-YQ==' } };
        entries[id] = catalog;
        const candidate = versions.createCandidate(rootDir, catalog);
        fs.writeFileSync(path.join(candidate.source, 'package.json'), JSON.stringify({ name, version, main: 'index.js',
            os: [process.platform], cpu: [process.arch],
            ailySubapp: { id, app: { enabled: false }, runtime: { headless: true, [declaration]: { kind, entry, apiVersion: 1 } } } }));
        fs.writeFileSync(path.join(candidate.source, 'index.js'), 'throw Error("Normal entry must not be started");\n');
        fs.writeFileSync(path.join(candidate.source, entry), id === 'aily-simulator'
            ? `module.exports=require(${JSON.stringify(providerModule)});\n`
            : `const value=module.exports={HOST_GATT_NATIVE_BACKEND_API_VERSION:1,constructed:0,disposed:0,failDispose:false,
createHostGattNativeBackend(){value.constructed++;return {scan(){throw Error('No Native scan in offline test');},
createDriver(){throw Error('No Native driver');},releaseSelection(){},async dispose(){if(value.failDispose)throw Error('Native cleanup unknown');value.disposed++;}};}};\n`);
        const published = versions.publishCandidate(rootDir, catalog, candidate); versions.activate(rootDir, catalog, published);
        roots[id] = published.packagePath;
    }
    const manager = createSubappManager({ rootDir, updateRootDir: path.join(rootDir, 'updates'),
        indexUrl: 'https://packages.example.test/subapp-index.json',
        fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(entries) }),
        runNpm: async () => assert.fail('No install or npm process'),
        getRunningSubappConfig: id => ({ ...readInstalledState(rootDir, entries[id]).config }),
    });
    const lockDir = path.join(rootDir, 'store', '.locks');
    const select = async () => {
        const value = await manager.prepareLaunchSet({ ids: ['aily-simulator', 'ble-debugger'], deferPreparedUpdate: true });
        selected.push(value); return value;
    };
    t.after(() => {
        for (const value of selected) value.release();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });
    function protectedByOriginalLock() { assert.equal(acquireInstallLock(lockDir), null); }
    function unlocked() { const release = acquireInstallLock(lockDir); assert.equal(typeof release, 'function'); release(); }
    function alter(id, change) {
        const file = path.join(roots[id], 'package.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        change(manifest); fs.writeFileSync(file, JSON.stringify(manifest));
    }
    return { rootDir, roots, entries: validateIndex(entries), manager, select, lockDir, protectedByOriginalLock, unlocked, alter };
}

test('real normal manager selects both version-store packages under one retained lock and preserves complete launch configs', async t => {
    const f = fixture(t); let calls = 0, selected;
    const installed = await loadInstalledMainGattComposition(async () => { calls++; selected = await f.select(); return selected; });
    assert.equal(calls, 1); assert.equal(installed.native.module.constructed, 0);
    assert.equal(installed.provider.module.LOCAL_GATT_PROVIDER_API_VERSION, 1);
    assert.equal(installed.native.version, '0.1.1'); assert.equal(installed.provider.version, '0.1.0');
    for (const launch of selected.launches) {
        assert.deepEqual(launch.config, readInstalledState(f.rootDir, f.entries[launch.id]).config);
        assert.equal(launch.config.env.AILY_SUBAPP_SOURCE, 'version-store');
        assert.equal(launch.config.env.AILY_SUBAPP_PACKAGE_PATH, f.roots[launch.id]);
    }
    f.protectedByOriginalLock(); await installed.release(); await installed.release(); f.unlocked();
    const single = await f.manager.prepareLaunch({ id: 'aily-simulator', deferPreparedUpdate: true });
    assert.deepEqual(single.config, selected.launches[0].config); f.protectedByOriginalLock(); single.release(); f.unlocked();
});

test('set admission rejects duplicate or nondeferred lists and the public single-launch API cannot take a set', async t => {
    const f = fixture(t);
    for (const value of [{ ids: ['aily-simulator', 'aily-simulator'], deferPreparedUpdate: true },
        { ids: ['aily-simulator', 'ble-debugger'], deferPreparedUpdate: false }, { ids: [], deferPreparedUpdate: true }]) {
        await assert.rejects(f.manager.prepareLaunchSet(value)); f.unlocked();
    }
    await assert.rejects(f.manager.prepareLaunch({ ids: ['aily-simulator', 'ble-debugger'], deferPreparedUpdate: true })); f.unlocked();
});

test('real normal platform refusal of either member returns no partial set and releases the installation lock', async t => {
    const f = fixture(t);
    f.alter('ble-debugger', manifest => { manifest.os = [process.platform === 'darwin' ? 'win32' : 'darwin']; });
    await assert.rejects(f.select(), /does not support/); f.unlocked();
});

test('whole loader retains exact capability, API and package-entry confinement checks for the second package', async t => {
    for (const invalid of ['capability', 'api', 'external-entry']) {
        const f = fixture(t), entry = path.join(f.roots['ble-debugger'], 'host-gatt-native-backend.cjs');
        if (invalid === 'capability') f.alter('ble-debugger', manifest => { manifest.ailySubapp.runtime.localGattBackend.extra = true; });
        if (invalid === 'api') fs.writeFileSync(entry, 'module.exports={HOST_GATT_NATIVE_BACKEND_API_VERSION:0};');
        if (invalid === 'external-entry') {
            const outside = path.join(f.rootDir, 'outside.cjs'); fs.writeFileSync(outside, 'throw Error("MUST NOT EXECUTE");');
            fs.unlinkSync(entry); fs.symlinkSync(outside, entry);
        }
        await assert.rejects(loadInstalledMainGattComposition(f.select), error => !error.message.includes('MUST NOT EXECUTE'));
        f.unlocked();
    }
});

test('validation failure with failed group release retains only the original whole holder for explicit retry', async t => {
    const f = fixture(t); let failRelease = true, releases = 0;
    fs.writeFileSync(path.join(f.roots['ble-debugger'], 'host-gatt-native-backend.cjs'), 'module.exports={HOST_GATT_NATIVE_BACKEND_API_VERSION:0};');
    let caught;
    try {
        await loadInstalledMainGattComposition(async () => {
            const selected = await f.select();
            return { launches: selected.launches, async release() { releases++; if (failRelease) throw Error('Group selection release unknown'); selected.release(); } };
        });
    } catch (error) { caught = error; }
    assert(caught instanceof AggregateError); assert.equal(caught.retainedInstalledOwner.module, null);
    f.protectedByOriginalLock(); await assert.rejects(caught.retainedInstalledOwner.release(), /release unknown/);
    failRelease = false; await caught.retainedInstalledOwner.release(); await caught.retainedInstalledOwner.release();
    assert.equal(releases, 3); f.unlocked();
});

function trustedContext() {
    const scope = { worldId: 'world', nodeId: 'node', clockDomainId: 'clock' };
    return { schemaVersion: 1, kind: 'aily-session-bluetooth-context', sessionId: 'offline-session',
        sceneRevision: 'a'.repeat(64), runtimeGeneration: 1, runtimeTimeEpoch: 1, sessionState: 'running', unavailableReason: null,
        bluetooth: { descriptor: { schemaVersion: 1, kind: 'aily-bluetooth-controller-port', scope,
            profileId: 'offline-profile', executionId: 'offline-execution', framing: 'hci-h4-v1', controllerModes: ['le'], aclDataPacketBytes: 251,
            limits: { maxBufferedPackets: 4, maxBufferedBytes: 4096, maxReadPackets: 4, maxReadBytes: 4096, maxPendingWrites: 2 } },
            snapshot: { schemaVersion: 1, kind: 'aily-bluetooth-controller-snapshot', scope, generation: 1, timeEpoch: 1, connectionEpoch: 1,
                state: 'open', readSequence: 0, writeSequence: 0, readBufferedPackets: 0, readBufferedBytes: 0,
                writeQueueCreditPackets: 2, writeQueueCreditBytes: 4096, pendingWrites: 0, droppedPackets: 0, droppedBytes: 0 } } };
}
function owner(f, options = {}) {
    const control = { requireCurrent() {}, async query() { return trustedContext(); },
        async attach() { assert.fail('No grant or Runtime attach'); }, async detach() {}, registerOwnerRelease() { return () => {}; } };
    const value = createMainGattProviderOwner({ prepareLaunch: f.select, MessageChannelMain: class {},
        dialog: { async showMessageBox() { assert.fail('No physical selection'); } }, getMainWindow: () => ({ isDestroyed: () => false }),
        resolveOriginalOwnerBluetoothControl: async () => control, ...options });
    const input = { authority: { senderId: 1, toolId: 'simulator', streamId: 'original', bindingId: 'original-binding' },
        producerId: 'original-producer', requireCurrentController() {}, choosePeer: value.choosePeer };
    return { value, input };
}

test('whole composition does not release real manager protection until actual Native cleanup succeeds', async t => {
    const f = fixture(t), h = owner(f), port = await h.value.bind(h.input);
    assert(port); f.protectedByOriginalLock();
    const native = require(path.join(f.roots['ble-debugger'], 'host-gatt-native-backend.cjs'));
    assert.equal(native.constructed, 1); native.failDispose = true;
    await assert.rejects(port.close()); f.protectedByOriginalLock(); assert.equal(native.disposed, 0);
    native.failDispose = false; await port.close(); await h.value.dispose();
    assert.equal(native.disposed, 1); f.unlocked();
});

test('late whole acquisition after controller cancellation joins the same group without publishing a binding or Native scan', async t => {
    const f = fixture(t), gate = Promise.withResolvers(); let installed, entered = Promise.withResolvers(), current = true;
    const h = owner(f, { loadComposition: async prepare => {
        installed = await loadInstalledMainGattComposition(prepare); entered.resolve(); await gate.promise; return installed;
    } });
    h.input.requireCurrentController = () => { if (!current) throw Error('Original controller ended'); };
    const binding = h.value.bind(h.input); await entered.promise;
    f.protectedByOriginalLock(); current = false; gate.resolve();
    assert.equal(await binding, null); await h.value.dispose(); f.unlocked();
});

test('failed acquisition before any Native connection lets original owner disposal confirm clean retirement', async t => {
    const f = fixture(t);
    f.alter('ble-debugger', manifest => { manifest.ailySubapp.runtime.localGattBackend.apiVersion = 0; });
    const h = owner(f); assert.equal(await h.value.bind(h.input), null);
    await h.value.dispose(); f.unlocked();
});
