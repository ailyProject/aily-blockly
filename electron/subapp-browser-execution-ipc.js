'use strict';

const { readBrowserExecutionSource } = require('./subapp-browser-execution-source');

/** Low-frequency trusted composition only. The JSON endpoint contains an opaque
 * instance id; the actual port is handed off separately to its authorized owner. */
function registerBrowserExecutionHandlers({ ipcMain, host, supervisor, prepareLaunch, resolveRuntime }) {
    const leases = new Map();
    const owner = (event, input) => {
        if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) throw new Error('Browser execution requires the owner main frame');
        const guard = supervisor.createOwnerGuard(event.sender, input);
        const runtime = resolveRuntime(input.toolId, event.sender.id);
        if (!runtime || runtime.streamId !== guard.runtime.streamId) throw new Error('Registered Runtime changed');
        return { guard, runtime, key: JSON.stringify([event.sender.id, input.generation, input.ownerSessionId, input.toolId]) };
    };
    ipcMain.handle('subapp-browser-execution', async (event, input = {}) => {
        const { guard, runtime, key } = owner(event, input);
        if (input.action === 'acquire') {
            const existing = leases.get(key);
            if (existing) {
                if (existing.releasing) throw new Error('Browser execution owner is being released');
                const endpoint = await existing.pending; guard();
                if (existing.runtimeId === runtime.streamId && host.isCurrent(existing)) return endpoint;
                if (leases.get(key) !== existing) throw new Error('Browser execution owner changed during acquisition');
                leases.delete(key); existing.removeCleanup?.();
            }
            const record = { runtimeId: runtime.streamId, ownerId: event.sender.id, leaseId: input.ownerSessionId };
            leases.set(key, record);
            try {
                record.removeCleanup = guard.attachCleanup(() => { record.revoked = true; if (leases.get(key) === record) leases.delete(key); });
            } catch (error) { if (leases.get(key) === record) leases.delete(key); throw error; }
            record.pending = (async () => {
            // Selection and manifest come from main-process package manager, never IPC.
            const prepared = await prepareLaunch({ id: runtime.hostInfo.runtimeConfig?.catalogId || input.toolId, deferPreparedUpdate: true });
            try {
                guard();
                const config = prepared.config;
                if (config.id !== input.toolId || config.version !== runtime.hostInfo.runtimeConfig?.version
                    || config.packagePath !== runtime.hostInfo.runtimeConfig?.packagePath) {
                    throw new Error('Browser execution selected package differs from the running Runtime');
                }
                const source = readBrowserExecutionSource(config);
                const acquired = await host.acquire({ runtimeId: runtime.streamId, source, ownerId: event.sender.id,
                    leaseId: input.ownerSessionId, guard });
                guard();
                if (leases.get(key) !== record || record.revoked) throw new Error('Browser execution owner ended during acquisition');
                record.executionId = acquired.executionId;
                return { endpoint: { kind: 'browser-message-port', runtimeId: acquired.executionId }, version: acquired.version };
            } finally { prepared.release(); }
            })();
            try { return await record.pending; }
            catch (error) { if (leases.get(key) === record) leases.delete(key); record.removeCleanup?.(); throw error; }
        }
        const lease = leases.get(key);
        if (!lease || lease.runtimeId !== runtime.streamId || input.runtimeId !== lease.executionId) {
            throw new Error('Browser execution handle is stale or belongs to another owner');
        }
        if (lease.releasing && input.action !== 'release') throw new Error('Browser execution owner is being released');
        if (input.action === 'connect') {
            return host.connect({ ...lease, guard, target: event.sender, purpose: 'agent' });
        }
        if (input.action === 'openView') return host.openView({ ...lease, guard, surface: input.surface });
        if (input.action === 'closeView') return host.closeView({ ...lease, guard, connectionId: input.connectionId });
        if (input.action === 'release') {
            lease.releasing = true;
            const receipt = await host.release(lease);
            if (leases.get(key) === lease) leases.delete(key);
            lease.removeCleanup?.();
            return receipt;
        }
        throw new Error('Unknown Browser execution action');
    });
    return host;
}

module.exports = { registerBrowserExecutionHandlers };
