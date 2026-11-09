'use strict';
const { isMainNetworkEndpointSelection } = require('./subapp-network-endpoint-selection');
const { createMainConnectivityHostBoundary } = require('./subapp-connectivity-host-boundary');

/** Fixed endpoint policy stays in the existing Network selection/provider;
 * sender, cancellation and retryable cleanup ownership are shared with GATT. */
function createMainNetworkHostBoundary({ protocol, selection = null, resolveOriginalOwnerNetworkPort, ...ports } = {}) {
    return createMainConnectivityHostBoundary({ ...ports,
        validateRequest: protocol?.validateHostNetworkProviderRequestV1,
        validateExchange: protocol?.validateHostNetworkProviderExchangeV1,
        createUnavailableCatalog: protocol?.createUnavailableHostConnectivityCatalogV1,
        limits: protocol?.HOST_NETWORK_PROVIDER_LIMITS,
        resultKind: 'aily-host-network-provider-result', errorKind: 'aily-main-network-ipc-error',
        configured: isMainNetworkEndpointSelection(selection) && typeof resolveOriginalOwnerNetworkPort === 'function',
        resolveOriginalOwnerPort: input => resolveOriginalOwnerNetworkPort(Object.freeze({ ...input, selection })),
    });
}

function registerMainNetworkHostHandlers({ ipcMain, installHost, ...ports }) {
    if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof installHost !== 'function') throw new TypeError('Normal Main IPC owner ports are required');
    const host = createMainNetworkHostBoundary(ports);
    ipcMain.handle('subapp-local-network', (event, input) => host.invoke(event, input));
    installHost(host);
    return host;
}
module.exports = { createMainNetworkHostBoundary, registerMainNetworkHostHandlers };
