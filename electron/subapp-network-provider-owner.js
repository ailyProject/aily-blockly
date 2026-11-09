'use strict';
const { randomUUID } = require('node:crypto');
const { loadInstalledMainNetworkBackend } = require('./subapp-network-installed-backend');
const { createMainConnectivityProviderOwner } = require('./subapp-connectivity-provider-owner');

/** Network-specific fixed route policy over the shared Main owner lifetime. */
function createMainNetworkProviderOwner({ prepareLaunch, configuration, MessageChannelMain,
    resolveOriginalOwnerNetworkControl, loadBackend = loadInstalledMainNetworkBackend,
    onBindingRetired, onBindingState }) {
    function context(module, raw) {
        if (raw === null) return null;
        const value = module.validateSessionNetworkContextSnapshot(raw);
        if (value.sessionState !== 'running' || value.sceneRevision === null || !value.network || value.network.snapshot.state !== 'open') return null;
        const { descriptor, snapshot } = value.network;
        return Object.freeze({ executionId: descriptor.executionId, state: 'running', scope: module.validateHostConnectivityScopeV1({
            sessionId: value.sessionId, sceneRevision: value.sceneRevision, ...descriptor.scope,
            runtimeGeneration: value.runtimeGeneration, coreGeneration: snapshot.generation,
            timeEpoch: snapshot.timeEpoch, connectionEpoch: snapshot.connectionEpoch }) });
    }
    async function acquireComposition() {
        let installed, driver, provider;
        const composition = {
            context: raw => context(installed.module, raw),
            bind({ input, authority, requireCurrentAuthority, trustedContext, registerOwnerRelease }) {
                return provider.bind({ authority, requireCurrentAuthority, trustedCurrentContextAsync: trustedContext,
                    chooseEndpoints: (choice, signal) => input.selection.chooseEndpoints(choice, signal, requireCurrentAuthority), registerOwnerRelease });
            },
            serve: input => installed.module.serveHostNetworkMessagePort(input),
            attachment(grant, descriptor) {
                const routes = configuration.routes.filter(route => grant.resourceIds.includes(route.endpointId));
                if (routes.length !== grant.resourceIds.length) throw new Error('Selected fixed guest routes are incomplete');
                return { sessionId: grant.scope.sessionId, descriptor, grant, routes };
            },
            async close() { if (provider) await provider.dispose(); else if (driver) await driver.dispose(); await installed.release(); },
        };
        try {
            try { installed = await loadBackend(prepareLaunch); }
            catch (error) { if (error.retainedInstalledOwner) installed = error.retainedInstalledOwner; throw error; }
            const module = installed.module;
            if (module.HOST_NETWORK_MESSAGE_PORT_DISPOSAL_SETTLEMENT_VERSION !== 1)
                throw new Error('Installed network grant disposal settlement API is unavailable');
            if (module.HOST_NETWORK_MESSAGE_PORT_TERMINAL_RESULT_SETTLEMENT_VERSION !== 2)
                throw new Error('Installed network terminal result settlement API is unavailable');
            driver = module.createNodeHostNetworkDriver({ endpoints: configuration.endpoints });
            const limits = Object.fromEntries(['maxLeases', 'maxPendingRequests', 'maxQueuedRecords', 'maxQueuedBytes',
                'maxReadRecords', 'maxReadBytes', 'maxPayloadBytes', 'idleTimeoutMs'].map(name => [name, module.HOST_CONNECTIVITY_LIMITS[name]]));
            const descriptor = module.validateHostNetworkBackendDescriptorV1({ schemaVersion: 1,
                kind: 'aily-host-network-backend', backendId: 'aily.local-network.ip.v1', capability: 'network.ip',
                executionLocation: 'user-device', resourceLocation: 'user-device', permissionAuthority: 'local-user',
                availability: 'available', permissionState: 'prompt', unavailableReason: null,
                protocols: ['tcp', 'udp', 'dns'], ipVersions: [4, 6], limits });
            provider = module.createNodeHostNetworkProvider({ hostInstanceId: 'local-network:' + randomUUID(), backend: { descriptor, driver } });
            return composition;
        } catch (error) {
            if (installed) {
                try { await composition.close(); }
                catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Installed network composition remains owned'), { retainedComposition: composition }); }
            }
            throw error;
        }
    }
    return createMainConnectivityProviderOwner({ configured: !!configuration, MessageChannelMain,
        resolveOriginalOwnerControl: resolveOriginalOwnerNetworkControl, acquireComposition, onBindingRetired, onBindingState });
}
module.exports = { createMainNetworkProviderOwner };
