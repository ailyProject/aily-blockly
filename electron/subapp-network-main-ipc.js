'use strict';
const path = require('node:path');
const { CONFIG_FILE_NAME, readMainNetworkHostConfiguration } = require('./subapp-network-host-config');
const { createMainNetworkEndpointSelection } = require('./subapp-network-endpoint-selection');
const { createMainNetworkNativeChooser } = require('./subapp-network-native-chooser');
const { createMainNetworkHostBoundary } = require('./subapp-network-host-boundary');
const { createMainNetworkProviderOwner } = require('./subapp-network-provider-owner');

async function loadInstalledNetworkProtocol() {
    // Normal installed Blockly SDK dependency resolution only. A browser/RPC
    // path, environment override or source-repository fallback is forbidden.
    return { ...await import('@aily-project/simulator-protocol/connectivity-network-provider'),
        ...await import('@aily-project/simulator-protocol/connectivity-host') };
}
function registerConfiguredMainNetworkHostHandlers({ ipcMain, app, dialog, getMainWindow, requireController,
    installHost, prepareLaunch, MessageChannelMain, resolveOriginalOwnerNetworkControl, loadProtocol = loadInstalledNetworkProtocol,
    onError = message => console.warn('[LocalNetwork]', message) }) {
    if (!ipcMain || typeof ipcMain.handle !== 'function' || !app || typeof app.getPath !== 'function' || typeof installHost !== 'function') throw new TypeError('Normal Main network IPC composition is unavailable');
    const configurationPath = path.join(app.getPath('userData'), CONFIG_FILE_NAME);
    let host = null, providerOwner = null, disposed = false, unavailableReason = null;
    const ready = Promise.resolve().then(async () => {
        const protocol = await loadProtocol();
        let configuration = null;
        try { configuration = await readMainNetworkHostConfiguration(configurationPath); }
        catch { unavailableReason = 'invalid-normal-configuration'; onError(unavailableReason); }
        const showChooser = createMainNetworkNativeChooser({ dialog, getMainWindow });
        const selection = configuration && showChooser ? createMainNetworkEndpointSelection({ resources: configuration.resources, showChooser }) : null;
        if (selection && typeof resolveOriginalOwnerNetworkControl === 'function' && typeof prepareLaunch === 'function' && typeof MessageChannelMain === 'function') {
            providerOwner = createMainNetworkProviderOwner({ prepareLaunch, configuration, MessageChannelMain, resolveOriginalOwnerNetworkControl,
                onBindingState: state => {
                    const main = getMainWindow(), authority = state.authority;
                    if (main && !main.isDestroyed() && !main.webContents.isDestroyed() && main.webContents.id === authority.senderId) {
                        // Exact original Main authority only; Workspace owns its Host instance mapping.
                        main.webContents.send('subapp-local-network-binding-state', { toolId: authority.toolId,
                            streamId: authority.streamId, bindingId: authority.bindingId, revision: state.revision,
                            phase: state.phase, selection: state.selection, grant: state.grant });
                    }
                },
                onBindingRetired: authority => {
                    const main = getMainWindow();
                    if (main && !main.isDestroyed() && !main.webContents.isDestroyed() && main.webContents.id === authority.senderId) {
                        main.webContents.send('subapp-local-network-lifetime-ended', { toolId: authority.toolId,
                            streamId: authority.streamId, bindingId: authority.bindingId });
                    }
                } });
        }
        host = createMainNetworkHostBoundary({ protocol, getMainWindow, requireController, selection,
            ...(providerOwner ? { resolveOriginalOwnerNetworkPort: input => providerOwner.bind(input) } : {}) });
        if (disposed) { await host.dispose(); await providerOwner?.dispose(); }
        return host;
    }).catch(error => { unavailableReason ??= 'installed-network-module-unavailable'; onError(unavailableReason); throw error; });
    void ready.catch(() => undefined);
    const unavailable = () => ({ kind: 'aily-main-network-ipc-error', ok: false, errorCode: 'unavailable' });
    const withHost = async action => {
        let current;
        try { current = await ready; }
        catch (error) { if (!host) return; throw error; }
        return action(current);
    };
    ipcMain.handle('subapp-local-network', async (event, input) => {
        try { return await (await ready).invoke(event, input); }
        catch { return unavailable(); }
    });
    const original = Object.freeze({
        async closeBinding(authority) { await withHost(current => current.closeBinding(authority)); },
        async closeRuntime(streamId) { await withHost(current => current.closeRuntime(streamId)); },
        async closeSender(senderId) { await withHost(current => current.closeSender(senderId)); },
        async dispose() {
            disposed = true;
            // Module-load failure owns no network resource. An acquired host
            // still retains and reports every actual cleanup failure.
            const results = await Promise.allSettled([withHost(current => current.dispose()), providerOwner?.dispose()]);
            if (results.some(result => result.status === 'rejected')) throw new Error('Original Main network resources remain unconfirmed');
        },
        snapshot: () => Object.freeze({ ready: !!host, disposed, unavailableReason,
            ...(host ? { owner: host.snapshot() } : {}) }),
    });
    installHost(original);
    return original;
}
module.exports = { registerConfiguredMainNetworkHostHandlers, loadInstalledNetworkProtocol };
