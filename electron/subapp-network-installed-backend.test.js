'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadInstalledMainNetworkBackend } = require('./subapp-network-installed-backend');

async function fixture(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-network-installed-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'package'); await fs.mkdir(root);
    const manifest = { name: '@aily-project/aily-simulator', version: '1.2.3', ailySubapp: { runtime: {
        localNetworkBackend: { kind: 'aily-local-network-backend', apiVersion: 1, entry: 'local-network-backend.cjs' } } } };
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
    const exports = ['createNodeHostNetworkProvider', 'createNodeHostNetworkDriver', 'validateHostNetworkBackendDescriptorV1',
        'validateHostNetworkProviderRequestV1', 'validateHostNetworkProviderExchangeV1', 'validateHostConnectivityScopeV1',
        'validateSessionNetworkContextSnapshot', 'serveHostNetworkMessagePort'];
    await fs.writeFile(path.join(root, 'local-network-backend.cjs'), 'module.exports={LOCAL_NETWORK_BACKEND_API_VERSION:1,' + exports.map(name => `${name}(){}`).join(',') + '};\n');
    let releases = 0;
    const prepared = { config: { catalogId: 'aily-simulator', packageName: manifest.name, version: manifest.version, packagePath: root },
        async release() { releases++; if (options.release) await options.release(); } };
    const prepareLaunch = async input => { assert.deepEqual(input, { id: 'aily-simulator', deferPreparedUpdate: true }); return prepared; };
    return { directory, root, manifest, prepared, prepareLaunch, releases: () => releases };
}

test('installed backend retains its normal package holder until actual owner release succeeds', async t => {
    const options = { fail: true, release: async () => { if (options.fail) throw Error('actual holder still retained'); } };
    const f = await fixture(t, options), installed = await loadInstalledMainNetworkBackend(f.prepareLaunch);
    assert.equal(f.releases(), 0); assert.equal(installed.version, f.manifest.version);
    await assert.rejects(installed.release(), /still retained/); options.fail = false;
    await installed.release(); await installed.release(); assert.equal(f.releases(), 2);
});

test('invalid installed module plus failed holder release exports the exact retryable retained owner', async t => {
    const options = { fail: true, release: async () => { if (options.fail) throw Error('actual holder still retained'); } };
    const f = await fixture(t, options); await fs.writeFile(path.join(f.root, 'local-network-backend.cjs'), 'module.exports={LOCAL_NETWORK_BACKEND_API_VERSION:1};\n');
    let failure; try { await loadInstalledMainNetworkBackend(f.prepareLaunch); } catch (error) { failure = error; }
    assert(failure instanceof AggregateError); assert.equal(failure.retainedInstalledOwner.module, null);
    assert.equal(f.releases(), 1); await assert.rejects(failure.retainedInstalledOwner.release(), /still retained/);
    options.fail = false; await failure.retainedInstalledOwner.release(); await failure.retainedInstalledOwner.release();
    assert.equal(f.releases(), 3);
});

test('a backend symlink cannot escape the verified installed package and its holder is released', async t => {
    const f = await fixture(t); const external = path.join(f.directory, 'outside.cjs');
    await fs.writeFile(external, 'throw Error("Escaped module must not execute");\n');
    await fs.unlink(path.join(f.root, 'local-network-backend.cjs')); await fs.symlink(external, path.join(f.root, 'local-network-backend.cjs'));
    await assert.rejects(loadInstalledMainNetworkBackend(f.prepareLaunch), /escapes its package/); assert.equal(f.releases(), 1);
});

test('running package identity and manifest version must agree before the optional module executes', async t => {
    const f = await fixture(t); f.prepared.config.version = '1.2.4';
    await assert.rejects(loadInstalledMainNetworkBackend(f.prepareLaunch), /version changed/); assert.equal(f.releases(), 1);
});

test('normal installed backend requires the package manager and has no source or development fallback', async () => {
    await assert.rejects(loadInstalledMainNetworkBackend(), /installed package manager/);
});
