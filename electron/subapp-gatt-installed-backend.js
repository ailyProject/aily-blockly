'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const NATIVE = Object.freeze({ catalogId: 'ble-debugger', packageName: '@aily-project/subapp-ble-debugger',
    declaration: 'localGattBackend', kind: 'aily-local-gatt-native-backend', entry: 'host-gatt-native-backend.cjs',
    version: 'HOST_GATT_NATIVE_BACKEND_API_VERSION', functions: ['createHostGattNativeBackend'] });
const PROVIDER = Object.freeze({ catalogId: 'aily-simulator', packageName: '@aily-project/aily-simulator',
    declaration: 'localGattProvider', kind: 'aily-local-gatt-provider', entry: 'local-gatt-backend.cjs',
    version: 'LOCAL_GATT_PROVIDER_API_VERSION', functions: ['createNodeHostGattProvider',
        'validateHostGattProviderRequestV1', 'validateHostGattProviderExchangeV1',
        'validateSessionBluetoothContextSnapshot', 'validateHostConnectivityScopeV1'] });

function retainedHolder(prepared, module, identity) {
    let released = false, flight = null;
    return Object.freeze({ module, ...identity,
        release() {
            if (released) return Promise.resolve();
            if (flight) return flight;
            const original = Promise.resolve().then(() => prepared.release()).then(() => { released = true; });
            flight = original;
            void original.then(() => { if (flight === original) flight = null; },
                () => { if (flight === original) flight = null; });
            return original;
        } });
}

async function readInstalledModule(config, spec) {
        if (config?.catalogId !== spec.catalogId || config.packageName !== spec.packageName)
            throw new Error('Installed GATT package identity changed');
        const root = await fs.realpath(config.packagePath);
        const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
        if (manifest.name !== config.packageName || manifest.version !== config.version)
            throw new Error('Installed GATT package version changed');
        const declaration = manifest.ailySubapp?.runtime?.[spec.declaration];
        if (!declaration || Object.keys(declaration).sort().join(',') !== 'apiVersion,entry,kind'
            || declaration.kind !== spec.kind || declaration.apiVersion !== 1 || declaration.entry !== spec.entry)
            throw new Error('Installed GATT capability is unavailable');
        const entry = await fs.realpath(path.join(root, spec.entry)), relative = path.relative(root, entry);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(entry)).isFile())
            throw new Error('Installed GATT entry escapes its package');
        const module = require(entry);
        if (module[spec.version] !== 1 || spec.functions.some(name => typeof module[name] !== 'function'))
            throw new Error('Installed GATT module API is incomplete');
        return Object.freeze({ module, packageName: manifest.name, version: manifest.version });
}

/** Only the normal verified package selection is accepted. Importing the
 * optional entry does not construct a provider, load Noble, scan or connect.
 * The caller must retire its actual resources before releasing these holders. */
async function loadInstalled(prepareLaunch, spec) {
    if (typeof prepareLaunch !== 'function') throw new TypeError('Normal installed package manager is required');
    const prepared = await prepareLaunch({ id: spec.catalogId, deferPreparedUpdate: true });
    const holder = retainedHolder(prepared, null, {});
    try {
        return Object.freeze({ ...await readInstalledModule(prepared.config, spec), release: holder.release });
    } catch (error) {
        try { await holder.release(); }
        catch (cleanupError) {
            throw Object.assign(new AggregateError([error, cleanupError], 'Installed GATT package cleanup remains owned'),
                { retainedInstalledOwner: holder });
        }
        throw error;
    }
}

/** One opaque, Main-fixed normal selection protects both package roots. There
 * is no first-package cache or second installation-lock acquisition. Any late
 * return remains owned by this whole holder until its real release succeeds. */
async function loadInstalledMainGattComposition(prepareLaunchSet) {
    if (typeof prepareLaunchSet !== 'function') throw new TypeError('Normal installed package selection set is required');
    let prepared;
    try { prepared = await prepareLaunchSet(); }
    catch (error) {
        if (error.retainedPreparedLaunchSet) error.retainedInstalledOwner = retainedHolder(error.retainedPreparedLaunchSet, null, {});
        throw error;
    }
    const holder = retainedHolder(prepared, null, {});
    try {
        const launches = prepared.launches;
        if (!Array.isArray(launches) || launches.length !== 2
            || launches[0]?.id !== PROVIDER.catalogId || launches[1]?.id !== NATIVE.catalogId)
            throw new Error('Installed GATT package selection set changed');
        const provider = await readInstalledModule(launches[0].config, PROVIDER);
        const native = await readInstalledModule(launches[1].config, NATIVE);
        return Object.freeze({ provider, native, release: holder.release });
    } catch (error) {
        try { await holder.release(); }
        catch (cleanupError) {
            throw Object.assign(new AggregateError([error, cleanupError], 'Installed GATT composition selection remains owned'),
                { retainedInstalledOwner: holder });
        }
        throw error;
    }
}

module.exports = {
    loadInstalledMainGattNativeBackend: prepareLaunch => loadInstalled(prepareLaunch, NATIVE),
    loadInstalledMainGattProvider: prepareLaunch => loadInstalled(prepareLaunch, PROVIDER),
    loadInstalledMainGattComposition,
};
