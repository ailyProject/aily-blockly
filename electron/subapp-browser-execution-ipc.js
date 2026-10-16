'use strict';

const { readBrowserExecutionSource } = require('./subapp-browser-execution-source');
const { readNodeControlSource } = require('./subapp-node-control-source');

/** Low-frequency trusted composition only. The JSON endpoint contains an opaque
 * instance id; the actual port is handed off separately to its authorized owner. */
function registerBrowserExecutionHandlers({ ipcMain, host, supervisor, prepareLaunch, resolveRuntime, broker, nodeControlBroker, ownerBridge }) {
    const leases = new Map();
    const owner = (event, input) => {
        if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) throw new Error('Browser execution requires the owner main frame');
        const guard = supervisor.createOwnerGuard(event.sender, input);
        const runtime = resolveRuntime(input.toolId, event.sender.id);
        if (!runtime || runtime.streamId !== guard.runtime.streamId) throw new Error('Registered Runtime changed');
        return { guard, runtime, key: JSON.stringify([event.sender.id, input.generation, input.ownerSessionId, input.toolId]) };
    };
    const bindProcess = async (lease, guard, runtime, toolId) => {
        if (!broker || !runtime.messagePort) throw new Error('Browser execution process message transport is unavailable');
        return broker.bind({ lease, guard, toolId, maxMessageBytes: runtime.messagePort.maxMessageBytes,
            expectedConnectionId: lease.bindingId,
            ...(ownerBridge ? { beforeAdmit: async bindingId => {
                if (lease.bindingId && lease.bindingId !== bindingId) throw new Error('Previous Browser owner connection requires confirmed retirement');
                lease.bindingId = bindingId;
                await host.bindNodeOwner({ ...lease, guard, bindingId, bridge: ownerBridge });
            } } : {}) });
    };
    async function acquire(event, input, guard, runtime, key) {
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
                record.removeCleanup = guard.attachCleanup(() => {
                    record.revoked = true;
                    // Public release retains its actual Host receipt until the
                    // supervised Node finalizer also succeeds, including retry.
                    if (!record.releasing && leases.get(key) === record) leases.delete(key);
                });
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
                record.nodeControlSource = readNodeControlSource(config);
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
    ipcMain.handle('subapp-browser-execution', async (event, input = {}) => {
        if (input.action === 'release') {
            if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) throw new Error('Browser execution requires the owner main frame');
            // Cleanup validates the original renderer incarnation and lease;
            // ordinary admission is already revoked on an authorized retry.
            supervisor.require(event.sender, input.generation);
            const key = JSON.stringify([event.sender.id, input.generation, input.ownerSessionId, input.toolId]);
            const lease = leases.get(key);
            if (!lease || input.runtimeId !== lease.executionId) throw new Error('Browser execution handle is stale or belongs to another owner');
            lease.releasing = true;
            const supervised = supervisor.release(event.sender, input);
            const actualHost = lease.hostReceipt ? Promise.resolve(lease.hostReceipt)
                : host.release(lease).then(receipt => { lease.hostReceipt = receipt; return receipt; });
            const [supervision, execution] = await Promise.allSettled([supervised, actualHost]);
            const failures = [supervision, execution].filter(result => result.status === 'rejected').map(result => result.reason);
            if (supervision.status === 'fulfilled' && !supervision.value.ok) {
                failures.push(new Error('Supervised Node owner cleanup remains unconfirmed'));
            }
            if (failures.length) throw new AggregateError(failures, 'Browser execution owner release requires retry');
            if (leases.get(key) === lease) leases.delete(key);
            lease.removeCleanup?.();
            return execution.value;
        }
        const { guard, runtime, key } = owner(event, input);
        if (input.action === 'acquire') return acquire(event, input, guard, runtime, key);
        if (input.action === 'bindProcess') {
            if (!broker || !runtime.messagePort) throw new Error('Browser execution process message transport is unavailable');
            await acquire(event, input, guard, runtime, key); guard();
            const lease = leases.get(key);
            if (!lease || lease.revoked || lease.releasing) throw new Error('Browser execution owner ended during process binding');
            return bindProcess(lease, guard, runtime, input.toolId);
        }
        const lease = leases.get(key);
        if (!lease || lease.runtimeId !== runtime.streamId || input.runtimeId !== lease.executionId) {
            throw new Error('Browser execution handle is stale or belongs to another owner');
        }
        if (lease.releasing && input.action !== 'release') throw new Error('Browser execution owner is being released');
        if (input.action === 'connect') {
            if (ownerBridge) await bindProcess(lease, guard, runtime, input.toolId);
            return host.connect({ ...lease, guard, target: event.sender, purpose: 'agent' });
        }
        if (input.action === 'openView') {
            let browserExecution;
            if (lease.nodeControlSource || ownerBridge) {
                if (lease.nodeControlSource && !nodeControlBroker) throw new Error('Registered Node control is unavailable');
                browserExecution = await bindProcess(lease, guard, runtime, input.toolId);
                guard();
            }
            const view = await host.openView({ ...lease, guard, surface: input.surface });
            if (!lease.nodeControlSource) return view;
            const connection = host.viewConnection({ ...lease, guard, connectionId: view.connectionId });
            let node;
            try {
                node = nodeControlBroker.connectView({ lease, guard, source: lease.nodeControlSource,
                    target: connection.target, assertCurrent: connection.assertCurrent, browserExecution });
                connection.attachCleanup(node.close);
                await node.ready; connection.assertCurrent(); return view;
            } catch (error) {
                const cleanup = await Promise.allSettled([node?.close(), host.closeView({ ...lease, guard, connectionId: view.connectionId })]);
                const failures = cleanup.filter(result => result.status === 'rejected');
                if (failures.length) throw new AggregateError([error, ...failures.map(result => result.reason)], 'Installed View cleanup requires retry');
                throw error;
            }
        }
        if (input.action === 'closeView') return host.closeView({ ...lease, guard, connectionId: input.connectionId });
        throw new Error('Unknown Browser execution action');
    });
    return host;
}

module.exports = { registerBrowserExecutionHandlers };
