'use strict';

const { isMainNetworkEndpointSelection } = require('./subapp-network-endpoint-selection');
function error(code) { return Object.assign(new Error(code), { networkCode: code }); }
function plain(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw error('invalid-input');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !descriptors[key] || !('value' in descriptors[key]))) throw error('invalid-input');
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw error('invalid-input'); return value; }
function key(authority) { return JSON.stringify([authority.senderId, authority.toolId, authority.streamId, authority.bindingId]); }
async function within(promise, timeoutMs) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(error('cleanup-unconfirmed')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
}

/** Only the normal Main composition may supply these private ports. Protocol
 * functions must come from its verified installed shared package, not Renderer
 * imports, source-repository fallbacks or copied endpoint/authorization logic.
 *
 * requireController proves only the existing workspace channel. It does NOT
 * prove a simulation Runtime owner, Core scope or grant. The separate
 * resolveOriginalOwnerNetworkPort is supplied only by normal Main's private
 * registered Browser-owner lookup. It returns the shared Node provider binding's
 * request/close, never an independently implemented network backend.
 * A null result means the resolver positively owns no acquisition and the
 * current original owner is unavailable. Partial acquisitions must instead
 * return their exact closeable fenced port; rejection is not cleanup proof.
 *
 * No current Core snapshot is cached or accepted from IPC here. Missing real
 * owner port, configured selection or normal chooser is strictly unavailable.
 * Normal window/preload/ProductService composition carries this channel without
 * converting the passive workspace binding into simulation-owner authority. */
function createMainNetworkHostBoundary({ getMainWindow, requireController, protocol,
    selection = null, resolveOriginalOwnerNetworkPort, cleanupTimeoutMs = 5000 } = {}) {
    if (typeof getMainWindow !== 'function' || typeof requireController !== 'function'
        || typeof protocol?.validateHostNetworkProviderRequestV1 !== 'function'
        || typeof protocol?.validateHostNetworkProviderExchangeV1 !== 'function'
        || typeof protocol?.createUnavailableHostConnectivityCatalogV1 !== 'function') throw new TypeError('Normal Main network boundary ports are required');
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 30000) throw new TypeError('Invalid cleanup budget');
    const limits = protocol.HOST_NETWORK_PROVIDER_LIMITS;
    if (!limits || !Number.isSafeInteger(limits.maxBindings) || !Number.isSafeInteger(limits.maxOwnerRequests)) throw new TypeError('Shared network limits are required');
    const configured = isMainNetworkEndpointSelection(selection) && typeof resolveOriginalOwnerNetworkPort === 'function';
    const owners = new Map();
    // Confirmed, resource-free receipts only. Unknown/failed acquisition or
    // cleanup remains in owners (and its normal maxBindings budget). A receipt
    // never grants a request and never substitutes for an unconfirmed close.
    const retired = new Map(), maxRetirementReceipts = 256;
    let disposed = false;
    const failure = (request, code) => protocol.validateHostNetworkProviderExchangeV1(request, { schemaVersion: 1,
        kind: 'aily-host-network-provider-result', requestId: request.requestId, requestSequence: request.requestSequence,
        operation: request.operation, ok: false, errorCode: code });
    const unavailable = request => request.operation === 'catalog'
        ? protocol.validateHostNetworkProviderExchangeV1(request, { schemaVersion: 1, kind: 'aily-host-network-provider-result',
            requestId: request.requestId, requestSequence: request.requestSequence, operation: 'catalog', ok: true,
            catalog: protocol.createUnavailableHostConnectivityCatalogV1() }) : failure(request, 'unavailable');
    function requireMainSender(event) {
        const main = getMainWindow();
        if (!main || main.isDestroyed() || event.sender !== main.webContents
            || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw error('permission-denied');
        if (disposed) throw error('lease-revoked');
        return main;
    }
    function rememberRetirement(authority, main, sender) {
        const ownerKey = key(authority);
        retired.delete(ownerKey);
        retired.set(ownerKey, { main, sender });
        while (retired.size > maxRetirementReceipts) retired.delete(retired.keys().next().value);
    }
    function guardFor(event, authority) {
        const originalMain = requireMainSender(event);
        const check = () => {
            const main = getMainWindow();
            if (!main || main !== originalMain || main.isDestroyed() || event.sender !== main.webContents
                || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame || authority.toolId !== 'simulator') throw error('permission-denied');
            try { requireController(event.sender.id, authority); } catch { throw error('permission-denied'); }
            if (disposed || getMainWindow() !== originalMain || originalMain.isDestroyed() || event.sender.isDestroyed()) throw error('lease-revoked');
        };
        check(); return check;
    }
    async function retire(owner) {
        owner.closed = true;
        for (const pending of owner.pending.values()) pending.abort.abort();
        if (owner.retired) return;
        if (owner.retirement) return owner.retirement;
        const flight = Promise.resolve().then(async () => {
            // Capture an eventual acquisition and join that exact original
            // owner. Unknown failure retains the record for explicit retry.
            const port = owner.port ?? (owner.acquisition ? await owner.acquisition : null);
            if (port) { owner.port = port; await port.close(); }
            owner.retired = true;
        });
        owner.retirement = flight;
        return flight.finally(() => { if (owner.retirement === flight) owner.retirement = null; });
    }
    async function closeOwner(owner) {
        owner.closed = true;
        for (const pending of owner.pending.values()) pending.abort.abort();
        if (owner.closing) return owner.closing;
        const flight = Promise.resolve().then(async () => {
            await within(retire(owner), cleanupTimeoutMs);
            await within(Promise.all([...owner.pending.values()].map(pending => pending.done)), cleanupTimeoutMs);
            if (owners.get(owner.key) === owner) owners.delete(owner.key);
            rememberRetirement(owner.authority, owner.main, owner.sender);
        });
        owner.closing = flight;
        return flight.finally(() => { if (owner.closing === flight) owner.closing = null; });
    }
    async function invoke(event, value) {
        let request;
        try {
            const descriptor = Object.getOwnPropertyDescriptor(value ?? {}, 'action');
            const action = descriptor && 'value' in descriptor ? descriptor.value : undefined;
            const input = plain(value, ['action', 'toolId', 'streamId', 'bindingId', ...(action === 'request' ? ['request'] : action === 'cancel' ? ['requestId'] : [])]);
            if (!['request', 'cancel', 'close'].includes(action)) throw error('invalid-input');
            if (input.toolId !== 'simulator') throw error('permission-denied');
            const authority = Object.freeze({ senderId: event.sender.id, toolId: 'simulator', streamId: id(input.streamId), bindingId: id(input.bindingId) });
            const ownerKey = key(authority);
            let owner = owners.get(ownerKey);
            if (action === 'close') {
                const main = requireMainSender(event), receipt = retired.get(ownerKey);
                // Cleanup may outlive its controller. Only this Main sender
                // and the exact original admitted tuple can join retained
                // resources or reuse their confirmed resource-free receipt.
                if (owner) {
                    if (owner.main !== main || owner.sender !== event.sender) throw error('permission-denied');
                    await closeOwner(owner);
                } else if (receipt) {
                    if (receipt.main !== main || receipt.sender !== event.sender) throw error('permission-denied');
                } else {
                    // A currently issued controller with no acquisition owns
                    // no resource. Unknown/foreign/retired tuples still fail.
                    guardFor(event, authority);
                    rememberRetirement(authority, main, event.sender);
                }
                return { ok: true, closed: true };
            }
            const guard = guardFor(event, authority);
            if (action === 'cancel') {
                const pending = owner?.pending.get(id(input.requestId));
                pending?.abort.abort();
                return { ok: true, cancelRequested: !!pending, completionConfirmed: false };
            }
            try { request = protocol.validateHostNetworkProviderRequestV1(input.request); } catch { throw error('invalid-input'); }
            if (!configured) {
                rememberRetirement(authority, getMainWindow(), event.sender);
                return unavailable(request);
            }
            if (!owner) {
                if (owners.size >= limits.maxBindings) {
                    rememberRetirement(authority, getMainWindow(), event.sender);
                    return failure(request, 'backpressure');
                }
                owner = { key: ownerKey, authority, guard, pending: new Map(), port: null, acquisition: null,
                    main: getMainWindow(), sender: event.sender,
                    closed: false, retired: false, noAcquisition: false, retirement: null, closing: null };
                owners.set(ownerKey, owner); // Reserve before any asynchronous trusted callback.
                retired.delete(ownerKey);
            }
            if (owner.closed) return failure(request, 'lease-revoked');
            if (owner.pending.has(request.requestId)) return failure(request, 'request-replayed');
            if (owner.pending.size >= limits.maxOwnerRequests) return failure(request, 'backpressure');
            const abort = new AbortController(); let complete;
            const done = new Promise(resolve => { complete = resolve; });
            owner.pending.set(request.requestId, { abort, done });
            try {
                if (!owner.acquisition) owner.acquisition = Promise.resolve().then(() => {
                    guard(); if (owner.closed) throw error('lease-revoked');
                    return resolveOriginalOwnerNetworkPort(Object.freeze({ authority, requireCurrentController: guard, selection }));
                }).then(port => {
                    // Publish the closeable original handle before checking
                    // cancellation or the channel again after the await.
                    owner.port = port;
                    if (port === null) { owner.noAcquisition = true; return null; }
                    if (!port || typeof port.request !== 'function' || typeof port.close !== 'function') throw error('unavailable');
                    return port;
                });
                const port = await owner.acquisition;
                guard(); if (owner.closed || abort.signal.aborted) throw error('cancelled');
                if (port === null) { await retire(owner); return unavailable(request); }
                const result = protocol.validateHostNetworkProviderExchangeV1(request, await port.request(request, abort.signal));
                guard();
                if (owner.closed || abort.signal.aborted) { await within(retire(owner), cleanupTimeoutMs); return failure(request, 'cancelled'); }
                return result;
            } catch (caught) {
                try { await within(retire(owner), cleanupTimeoutMs); }
                catch { return failure(request, 'cleanup-unconfirmed'); }
                return failure(request, ['cancelled', 'permission-denied', 'lease-revoked'].includes(caught.networkCode) ? caught.networkCode : 'unavailable');
            } finally {
                owner.pending.delete(request.requestId); complete();
                // A confirmed retired original port owns no remaining work.
                // Release the local slot; unknown/failed cleanup stays fenced
                // and retained. No business request is retried here.
                if (owner.retired && owner.pending.size === 0 && owners.get(owner.key) === owner) {
                    owners.delete(owner.key);
                    rememberRetirement(owner.authority, owner.main, owner.sender);
                }
            }
        } catch (caught) {
            const code = ['invalid-input', 'permission-denied', 'lease-revoked', 'cleanup-unconfirmed'].includes(caught.networkCode) ? caught.networkCode : 'unavailable';
            return request ? failure(request, code) : { kind: 'aily-main-network-ipc-error', ok: false, errorCode: code };
        }
    }
    return Object.freeze({ invoke,
        // Trusted Main cleanup hooks only, never an IPC authority payload.
        async closeBinding(authority) { const owner = owners.get(key(authority)); if (owner) await closeOwner(owner); },
        async closeSender(senderId) { const results = await Promise.allSettled([...owners.values()].filter(owner => owner.authority.senderId === senderId).map(closeOwner)); if (results.some(result => result.status === 'rejected')) throw error('cleanup-unconfirmed'); },
        async closeRuntime(streamId) { const results = await Promise.allSettled([...owners.values()].filter(owner => owner.authority.streamId === streamId).map(closeOwner)); if (results.some(result => result.status === 'rejected')) throw error('cleanup-unconfirmed'); },
        async dispose() { disposed = true; const results = await Promise.allSettled([...owners.values()].map(closeOwner)); if (results.some(result => result.status === 'rejected') || owners.size) throw error('cleanup-unconfirmed'); retired.clear(); },
        snapshot: () => Object.freeze({ configured, disposed, bindings: owners.size, pending: [...owners.values()].reduce((sum, owner) => sum + owner.pending.size, 0), fenced: [...owners.values()].filter(owner => owner.closed).length,
            retirementReceipts: retired.size, maxRetirementReceipts }),
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
