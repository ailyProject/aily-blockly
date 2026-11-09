'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadInstalledMainGattNativeBackend: native, loadInstalledMainGattProvider: provider } = require('./subapp-gatt-installed-backend');

async function fixture(t, type = 'native', release = async () => {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-gatt-installed-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'package'); await fs.mkdir(root);
    const n = type === 'native';
    const id = n ? 'ble-debugger' : 'aily-simulator', name = n ? '@aily-project/subapp-ble-debugger' : '@aily-project/aily-simulator';
    const entry = n ? 'host-gatt-native-backend.cjs' : 'local-gatt-backend.cjs';
    const key = n ? 'localGattBackend' : 'localGattProvider', kind = n ? 'aily-local-gatt-native-backend' : 'aily-local-gatt-provider';
    const version = n ? 'HOST_GATT_NATIVE_BACKEND_API_VERSION' : 'LOCAL_GATT_PROVIDER_API_VERSION';
    const methods = n ? ['createHostGattNativeBackend'] : ['createNodeHostGattProvider', 'validateHostGattProviderRequestV1',
        'validateHostGattProviderExchangeV1', 'validateSessionBluetoothContextSnapshot', 'validateHostConnectivityScopeV1'];
    const manifest = { name, version: '1.2.3', ailySubapp: { runtime: { [key]: { kind, entry, apiVersion: 1 } } } };
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(root, entry), `module.exports={${version}:1,constructed:0,${methods.map(m => `${m}(){this.constructed++;}`).join(',')}};\n`);
    let releases = 0;
    const prepared = { config: { catalogId: id, packageName: name, version: manifest.version, packagePath: root },
        async release() { releases++; await release(); } };
    const prepare = async input => { assert.deepEqual(input, { id, deferPreparedUpdate: true }); return prepared; };
    return { root, directory, entry, key, manifest, prepared, prepare, releases: () => releases, load: n ? native : provider };
}

test('both optional normal packages load lazily and one concurrent release retains its original settlement', async t => {
    for (const type of ['native', 'provider']) {
        let complete; const f = await fixture(t, type, () => new Promise(resolve => { complete = resolve; }));
        const installed = await f.load(f.prepare); assert.equal(installed.module.constructed, 0); assert.equal(f.releases(), 0);
        const first = installed.release(), second = installed.release(); assert.equal(first, second);
        await new Promise(resolve => setImmediate(resolve)); assert.equal(f.releases(), 1); complete(); await first;
        await installed.release(); assert.equal(f.releases(), 1);
    }
});

test('failed original holder release remains retryable and is never called a successful release', async t => {
    let fail = true; const f = await fixture(t, 'native', async () => { if (fail) throw Error('not released'); });
    const installed = await native(f.prepare); await assert.rejects(installed.release(), /not released/);
    fail = false; await installed.release(); await installed.release(); assert.equal(f.releases(), 2);
});

test('invalid optional module and failed validation cleanup retain the exact package holder', async t => {
    let fail = true; const f = await fixture(t, 'provider', async () => { if (fail) throw Error('still held'); });
    await fs.writeFile(path.join(f.root, f.entry), 'module.exports={LOCAL_GATT_PROVIDER_API_VERSION:0};');
    let failure; try { await provider(f.prepare); } catch (error) { failure = error; }
    assert(failure instanceof AggregateError); assert.equal(failure.retainedInstalledOwner.module, null);
    await assert.rejects(failure.retainedInstalledOwner.release(), /still held/);
    fail = false; await failure.retainedInstalledOwner.release(); assert.equal(f.releases(), 3);
});

test('package identity, version and exact runtime capability are checked before executing an entry', async t => {
    for (const change of [f => { f.prepared.config.catalogId = 'foreign'; }, f => { f.prepared.config.version = '2'; },
        async f => { f.manifest.ailySubapp.runtime[f.key].extra = true; await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify(f.manifest)); }]) {
        const f = await fixture(t); await fs.writeFile(path.join(f.root, f.entry), 'throw Error("MUST NOT EXECUTE");');
        await change(f); await assert.rejects(native(f.prepare), error => !error.message.includes('MUST NOT EXECUTE'));
        assert.equal(f.releases(), 1);
    }
});

test('an entry symlink cannot load an external source or development module', async t => {
    const f = await fixture(t), external = path.join(f.directory, 'outside.cjs');
    await fs.writeFile(external, 'throw Error("MUST NOT EXECUTE");');
    await fs.unlink(path.join(f.root, f.entry)); await fs.symlink(external, path.join(f.root, f.entry));
    await assert.rejects(native(f.prepare), /escapes its package/); assert.equal(f.releases(), 1);
});

test('missing normal manager and old Native API do not have any source fallback', async t => {
    await assert.rejects(native(), /installed package manager/);
    const f = await fixture(t); await fs.writeFile(path.join(f.root, f.entry), 'module.exports={createHostGattNativeBackend(){}};');
    await assert.rejects(native(f.prepare), /API is incomplete/); assert.equal(f.releases(), 1);
});
