'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

/** Normal verified installed Simulator package only. The update holder stays
 * owned until the caller has disposed the actual shared provider/driver. */
async function loadInstalledMainNetworkBackend(prepareLaunch) {
    if (typeof prepareLaunch !== 'function') throw new TypeError('Normal installed package manager is required');
    const prepared = await prepareLaunch({ id: 'aily-simulator', deferPreparedUpdate: true });
    try {
        const config = prepared.config;
        if (config?.catalogId !== 'aily-simulator' || config.packageName !== '@aily-project/aily-simulator') throw new Error('Normal Simulator package identity changed');
        const root = await fs.realpath(config.packagePath), manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
        if (manifest.name !== config.packageName || manifest.version !== config.version) throw new Error('Installed Simulator version changed');
        const declaration = manifest.ailySubapp?.runtime?.localNetworkBackend;
        if (!declaration || Object.keys(declaration).sort().join(',') !== 'apiVersion,entry,kind'
            || declaration.kind !== 'aily-local-network-backend' || declaration.apiVersion !== 1
            || declaration.entry !== 'local-network-backend.cjs') throw new Error('Installed local network backend is unavailable');
        const entry = await fs.realpath(path.join(root, declaration.entry)), relative = path.relative(root, entry);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(entry)).isFile()) throw new Error('Installed network backend entry escapes its package');
        const module = require(entry);
        if (module.LOCAL_NETWORK_BACKEND_API_VERSION !== 1 || ['createNodeHostNetworkProvider', 'createNodeHostNetworkDriver',
            'validateHostNetworkBackendDescriptorV1', 'validateHostNetworkProviderRequestV1', 'validateHostNetworkProviderExchangeV1',
            'validateHostConnectivityScopeV1', 'validateSessionNetworkContextSnapshot', 'serveHostNetworkMessagePort'].some(name => typeof module[name] !== 'function')) throw new Error('Installed local network backend API is incomplete');
        let released = false;
        return Object.freeze({ module, packageName: manifest.name, version: manifest.version,
            async release() { if (!released) { await prepared.release(); released = true; } } });
    } catch (error) {
        try { await prepared.release(); }
        catch (cleanupError) {
            // A failed validation does not erase the package update holder.
            // Publish its exact retryable owner to Main's quarantine path.
            let released = false;
            const retainedInstalledOwner = Object.freeze({ module: null,
                async release() { if (!released) { await prepared.release(); released = true; } } });
            throw Object.assign(new AggregateError([error, cleanupError], 'Installed network package cleanup remains owned'), { retainedInstalledOwner });
        }
        throw error;
    }
}

/** Event shape adapter only; wire validation/credit/cancel/dispose remains in
 * the one shared HostNetworkMessagePort server. No policy or DTO is copied. */
function adaptMainNetworkMessagePort(port) {
    let onmessage = null, onmessageerror = null, ownClose = false;
    const message = event => {
        if (event.ports?.length) { for (const transferred of event.ports) transferred.close(); onmessageerror?.(new Error('Unexpected network backend capability transfer')); return; }
        onmessage?.({ data: event.data });
    };
    const error = event => onmessageerror?.(event);
    const closed = () => { if (!ownClose) onmessageerror?.(new Error('Original network MessagePort closed')); };
    port.on('message', message); port.on('messageerror', error); port.on('close', closed);
    return {
        get onmessage() { return onmessage; }, set onmessage(value) { onmessage = value; },
        get onmessageerror() { return onmessageerror; }, set onmessageerror(value) { onmessageerror = value; },
        postMessage: value => port.postMessage(value), start: () => port.start(),
        close() { ownClose = true; port.removeListener('message', message); port.removeListener('messageerror', error); port.removeListener('close', closed); port.close(); },
    };
}
module.exports = { loadInstalledMainNetworkBackend, adaptMainNetworkMessagePort };
