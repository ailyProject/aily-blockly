'use strict';
const { createMainConnectivityHostBoundary } = require('./subapp-connectivity-host-boundary');
const { isMainGattNativeChooser } = require('./subapp-gatt-native-chooser');
const { randomUUID } = require('node:crypto');

const identity = value => JSON.stringify([value.senderId, value.toolId, value.streamId, value.bindingId]);
function fields(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid GATT binding input');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !descriptors[key] || !('value' in descriptors[key])))
        throw new TypeError('Invalid GATT binding fields');
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

/** GATT policy is an opt-in composition of the existing Main authority lane,
 * the shared typed provider and a real local chooser. This boundary does not
 * scan, construct a driver, accept Core facts or grant an RPC-selected peer. */
function createMainGattHostBoundary({ protocol, choosePeer = null, resolveOriginalOwnerGattPort, ...ports } = {}) {
    const producers = new Map();
    const boundary = createMainConnectivityHostBoundary({ ...ports,
        validateRequest: protocol?.validateHostGattProviderRequestV1,
        validateExchange: protocol?.validateHostGattProviderExchangeV1,
        createUnavailableCatalog: protocol?.createUnavailableHostConnectivityCatalogV1,
        limits: protocol?.HOST_GATT_PROVIDER_LIMITS,
        resultKind: 'aily-host-gatt-provider-result', errorKind: 'aily-main-gatt-ipc-error',
        producerIdentityKey: 'producerId',
        isCleanupRequest: request => request.operation === 'release',
        configured: isMainGattNativeChooser(choosePeer) && typeof resolveOriginalOwnerGattPort === 'function',
        resolveOriginalOwnerPort: input => resolveOriginalOwnerGattPort(Object.freeze({ ...input, choosePeer })),
    });
    function renew(record) {
        if (record.revision >= Number.MAX_SAFE_INTEGER) throw new Error('GATT producer revision exhausted');
        record.producerId = 'gatt-producer:' + randomUUID(); record.revision++; record.state = 'ready';
    }
    function retireProducer(authority) {
        const record = producers.get(identity(authority));
        if (record?.producerId === authority.producerId) renew(record);
    }
    const state = record => Object.freeze({ schemaVersion: 1, kind: 'aily-main-gatt-producer-state',
        producerId: record.producerId, revision: record.revision, state: record.state });
    const clear = predicate => { for (const [key, record] of producers) if (predicate(record.authority)) producers.delete(key); };
    return Object.freeze({ ...boundary, retireProducer,
        observeProducerPhase(authority, phase) {
            const record = producers.get(identity(authority));
            if (record?.producerId === authority.producerId && ['closing', 'cleanup-unconfirmed'].includes(phase)) record.state = phase;
        },
        async invoke(event, value) {
            try {
                const descriptor = Object.getOwnPropertyDescriptor(value ?? {}, 'action');
                const action = descriptor && 'value' in descriptor ? descriptor.value : undefined;
                if (action === 'binding-state') {
                    const input = fields(value, ['action', 'toolId', 'streamId', 'bindingId']);
                    const { authority } = boundary.authorize(event, { toolId: input.toolId, streamId: input.streamId, bindingId: input.bindingId });
                    const key = identity(authority); let record = producers.get(key);
                    if (!record) {
                        if (producers.size >= protocol.HOST_GATT_PROVIDER_LIMITS.maxBindings) throw new Error('GATT producer capacity exhausted');
                        record = { authority, producerId: null, revision: 0, state: 'ready' }; renew(record); producers.set(key, record);
                    }
                    return state(record);
                }
                const input = fields(value, ['action', 'toolId', 'streamId', 'bindingId', 'producerId',
                    ...(action === 'request' ? ['request'] : action === 'cancel' ? ['requestId'] : [])]);
                if (typeof input.producerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.producerId))
                    throw new TypeError('Invalid GATT producer identity');
                const bound = result => Object.freeze({ schemaVersion: 1, kind: 'aily-host-gatt-bound-provider-result',
                    producerId: input.producerId, result });
                const authority = { senderId: event.sender.id, toolId: input.toolId, streamId: input.streamId, bindingId: input.bindingId };
                const cleanupRequest = action === 'request' && protocol.validateHostGattProviderRequestV1(input.request).operation === 'release';
                if (action === 'close' || cleanupRequest)
                    boundary.authorizeCleanup(event, { toolId: input.toolId, streamId: input.streamId, bindingId: input.bindingId }, input.producerId);
                if (action === 'request') {
                    if (!cleanupRequest) boundary.authorize(event, { toolId: input.toolId, streamId: input.streamId, bindingId: input.bindingId });
                    const original = producers.get(identity(authority));
                    if (!cleanupRequest && (!original || original.producerId !== input.producerId || original.state !== 'ready')) {
                        const request = protocol.validateHostGattProviderRequestV1(input.request);
                        return bound(protocol.validateHostGattProviderExchangeV1(request, { schemaVersion: 1,
                            kind: 'aily-host-gatt-provider-result', requestId: request.requestId, requestSequence: request.requestSequence,
                            operation: request.operation, ok: false,
                            errorCode: original?.producerId === input.producerId && original.state === 'cleanup-unconfirmed'
                                ? 'cleanup-unconfirmed' : 'stale-scope' }));
                    }
                }
                if (action === 'close' || cleanupRequest) {
                    const record = producers.get(identity(authority));
                    if (record?.producerId === input.producerId) record.state = 'closing';
                }
                const result = await boundary.invoke(event, input);
                // Both paths are actual resource-free receipts: a precise
                // close or an acquisition positively confirmed to own nothing.
                if (result?.ok === true && (action === 'close'
                    || boundary.hasRetirementReceipt(authority, input.producerId)))
                    retireProducer({ ...authority, producerId: input.producerId });
                else if (action === 'close' || cleanupRequest) {
                    const record = producers.get(identity(authority));
                    if (record?.producerId === input.producerId) record.state = 'cleanup-unconfirmed';
                }
                if (action === 'request' && result?.kind === 'aily-host-gatt-provider-result') return bound(result);
                return result;
            } catch (error) {
                const code = ['permission-denied', 'lease-revoked', 'cleanup-unconfirmed', 'invalid-input'].includes(error.connectivityCode)
                    ? error.connectivityCode : error instanceof TypeError ? 'invalid-input' : 'unavailable';
                return { kind: 'aily-main-gatt-ipc-error', ok: false, errorCode: code };
            }
        },
        async closeBinding(authority) { await boundary.closeBinding(authority); clear(value => identity(value) === identity(authority)); },
        async closeSender(senderId) { await boundary.closeSender(senderId); clear(value => value.senderId === senderId); },
        async closeRuntime(streamId) { await boundary.closeRuntime(streamId); clear(value => value.streamId === streamId); },
        async dispose() { await boundary.dispose(); producers.clear(); },
    });
}

function registerMainGattHostHandlers({ ipcMain, installHost, ...ports }) {
    if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof installHost !== 'function')
        throw new TypeError('Normal Main GATT IPC owner ports are required');
    const host = createMainGattHostBoundary(ports);
    ipcMain.handle('subapp-local-gatt', (event, input) => host.invoke(event, input));
    installHost(host);
    return host;
}
module.exports = { createMainGattHostBoundary, registerMainGattHostHandlers };
