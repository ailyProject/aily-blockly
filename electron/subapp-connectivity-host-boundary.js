'use strict';

function error(code) { return Object.assign(new Error(code), { connectivityCode: code }); }
function plain(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw error('invalid-input');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !descriptors[key] || !('value' in descriptors[key]))) throw error('invalid-input');
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw error('invalid-input'); return value; }
function key(authority, producerId) { return JSON.stringify([authority.senderId, authority.toolId, authority.streamId, authority.bindingId, ...(producerId === undefined ? [] : [producerId])]); }
async function within(promise, timeoutMs) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(error('cleanup-unconfirmed')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
}

/** Shared Main sender/controller boundary for installed connectivity providers.
 * It captures no Core scope and grants no device access. Only the trusted
 * resolver can acquire a closeable provider bound to the original process
 * owner. Late acquisitions and failed cleanup remain owned across IPC cancel.
 * Backend-specific DTOs and selection policy are supplied by the wrappers. */
function createMainConnectivityHostBoundary({ getMainWindow, requireController,
    validateRequest, validateExchange, createUnavailableCatalog, limits, resultKind, errorKind,
    configured = false, resolveOriginalOwnerPort, producerIdentityKey = null, isCleanupRequest = null, cleanupTimeoutMs = 5000 } = {}) {
    if (typeof getMainWindow !== 'function' || typeof requireController !== 'function'
        || typeof validateRequest !== 'function' || typeof validateExchange !== 'function'
        || typeof createUnavailableCatalog !== 'function'
        || configured && typeof resolveOriginalOwnerPort !== 'function')
        throw new TypeError('Normal Main connectivity boundary ports are required');
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 30000)
        throw new TypeError('Invalid cleanup budget');
    if (!limits || !Number.isSafeInteger(limits.maxBindings) || limits.maxBindings < 1
        || !Number.isSafeInteger(limits.maxOwnerRequests) || limits.maxOwnerRequests < 1)
        throw new TypeError('Shared connectivity limits are required');
    if (typeof resultKind !== 'string' || typeof errorKind !== 'string') throw new TypeError('Connectivity result identity is required');
    const owners = new Map();
    // Confirmed, resource-free receipts only. Unknown/failed acquisition or
    // cleanup remains in owners (and its normal maxBindings budget). A receipt
    // never grants a request and never substitutes for an unconfirmed close.
    const retired = new Map(), maxRetirementReceipts = 256;
    let disposed = false;
    const failure = (request, code) => validateExchange(request, { schemaVersion: 1,
        kind: resultKind, requestId: request.requestId, requestSequence: request.requestSequence,
        operation: request.operation, ok: false, errorCode: code });
    const unavailable = request => request.operation === 'catalog'
        ? validateExchange(request, { schemaVersion: 1, kind: resultKind,
            requestId: request.requestId, requestSequence: request.requestSequence, operation: 'catalog', ok: true,
            catalog: createUnavailableCatalog() }) : failure(request, 'unavailable');
    function requireMainSender(event) {
        const main = getMainWindow();
        if (!main || main.isDestroyed() || event.sender !== main.webContents
            || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw error('permission-denied');
        if (disposed) throw error('lease-revoked');
        return main;
    }
    function rememberRetirement(authority, main, sender, producerId) {
        const ownerKey = key(authority, producerId);
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
    function cleanupGuardFor(event, authority, producerId) {
        const main = requireMainSender(event), original = owners.get(key(authority, producerId)) ?? retired.get(key(authority, producerId));
        if (!original) return guardFor(event, authority);
        const check = () => {
            if (requireMainSender(event) !== main || original.main !== main || original.sender !== event.sender)
                throw error('permission-denied');
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
            rememberRetirement(owner.authority, owner.main, owner.sender, owner.producerId);
        });
        owner.closing = flight;
        return flight.finally(() => { if (owner.closing === flight) owner.closing = null; });
    }
    async function invoke(event, value) {
        let request;
        try {
            const descriptor = Object.getOwnPropertyDescriptor(value ?? {}, 'action');
            const action = descriptor && 'value' in descriptor ? descriptor.value : undefined;
            const input = plain(value, ['action', 'toolId', 'streamId', 'bindingId', ...(producerIdentityKey ? [producerIdentityKey] : []), ...(action === 'request' ? ['request'] : action === 'cancel' ? ['requestId'] : [])]);
            if (!['request', 'cancel', 'close'].includes(action)) throw error('invalid-input');
            if (input.toolId !== 'simulator') throw error('permission-denied');
            const authority = Object.freeze({ senderId: event.sender.id, toolId: 'simulator', streamId: id(input.streamId), bindingId: id(input.bindingId) });
            const producerId = producerIdentityKey ? id(input[producerIdentityKey]) : undefined;
            const ownerKey = key(authority, producerId);
            let owner = owners.get(ownerKey);
            if (action === 'close') {
                const main = requireMainSender(event), receipt = retired.get(ownerKey);
                // Cleanup may outlive its controller. Only this Main sender
                // and the exact original admitted tuple can join retained
                // resources or reuse their confirmed resource-free receipt.
                if (owner) {
                    if (owner.main !== main || owner.sender !== event.sender) throw error('permission-denied');
                    try { await closeOwner(owner); } catch { throw error('cleanup-unconfirmed'); }
                } else if (receipt) {
                    if (receipt.main !== main || receipt.sender !== event.sender) throw error('permission-denied');
                } else {
                    // A currently issued controller with no acquisition owns
                    // no resource. Unknown/foreign/retired tuples still fail.
                    guardFor(event, authority);
                    rememberRetirement(authority, main, event.sender, producerId);
                }
                return { ok: true, closed: true };
            }
            let cleanupRequest = false;
            if (action === 'request' && isCleanupRequest) {
                requireMainSender(event);
                try { request = validateRequest(input.request); } catch { throw error('invalid-input'); }
                cleanupRequest = isCleanupRequest(request) === true;
            }
            const guard = cleanupRequest ? cleanupGuardFor(event, authority, producerId) : guardFor(event, authority);
            if (action === 'cancel') {
                const pending = owner?.pending.get(id(input.requestId));
                pending?.abort.abort();
                return { ok: true, cancelRequested: !!pending, completionConfirmed: false };
            }
            if (!request) try { request = validateRequest(input.request); } catch { throw error('invalid-input'); }
            if (cleanupRequest && !owner) return failure(request, 'lease-revoked');
            if (!configured) {
                rememberRetirement(authority, getMainWindow(), event.sender, producerId);
                return unavailable(request);
            }
            if (!owner) {
                if (owners.size >= limits.maxBindings) {
                    rememberRetirement(authority, getMainWindow(), event.sender, producerId);
                    return failure(request, 'backpressure');
                }
                owner = { key: ownerKey, authority, producerId, guard, pending: new Map(), port: null, acquisition: null,
                    main: getMainWindow(), sender: event.sender,
                    closed: false, retired: false, noAcquisition: false, retirement: null, closing: null };
                owners.set(ownerKey, owner); // Reserve before any asynchronous trusted callback.
                retired.delete(ownerKey);
            }
            if (owner.closed && !cleanupRequest) return failure(request, 'lease-revoked');
            if (owner.pending.has(request.requestId)) return failure(request, 'request-replayed');
            if (cleanupRequest ? [...owner.pending.values()].filter(value => value.cleanupRequest).length >= 16
                : owner.pending.size >= limits.maxOwnerRequests) return failure(request, 'backpressure');
            const abort = new AbortController(); let complete;
            const done = new Promise(resolve => { complete = resolve; });
            owner.pending.set(request.requestId, { abort, done, cleanupRequest });
            try {
                if (!owner.acquisition) owner.acquisition = Promise.resolve().then(() => {
                    guard(); if (owner.closed) throw error('lease-revoked');
                    return resolveOriginalOwnerPort(Object.freeze({ authority, requireCurrentController: guard, ...(producerIdentityKey ? { producerId } : {}) }));
                }).then(port => {
                    // Publish the closeable original handle before checking
                    // cancellation or the channel again after the await.
                    owner.port = port;
                    if (port === null) { owner.noAcquisition = true; return null; }
                    if (!port || typeof port.request !== 'function' || typeof port.close !== 'function') throw error('unavailable');
                    return port;
                });
                const port = await owner.acquisition;
                guard(); if (!cleanupRequest && (owner.closed || abort.signal.aborted)) throw error('cancelled');
                if (port === null) { await retire(owner); return unavailable(request); }
                const result = validateExchange(request, await port.request(request, abort.signal));
                guard();
                if (cleanupRequest) await within(retire(owner), cleanupTimeoutMs);
                else if (owner.closed || abort.signal.aborted) { await within(retire(owner), cleanupTimeoutMs); return failure(request, 'cancelled'); }
                return result;
            } catch (caught) {
                try { await within(retire(owner), cleanupTimeoutMs); }
                catch { return failure(request, 'cleanup-unconfirmed'); }
                return failure(request, ['cancelled', 'permission-denied', 'lease-revoked'].includes(caught.connectivityCode) ? caught.connectivityCode : 'unavailable');
            } finally {
                owner.pending.delete(request.requestId); complete();
                // A confirmed retired original port owns no remaining work.
                // Release the local slot; unknown/failed cleanup stays fenced
                // and retained. No business request is retried here.
                if (owner.retired && owner.pending.size === 0 && owners.get(owner.key) === owner) {
                    owners.delete(owner.key);
                    rememberRetirement(owner.authority, owner.main, owner.sender, owner.producerId);
                }
            }
        } catch (caught) {
            const code = ['invalid-input', 'permission-denied', 'lease-revoked', 'cleanup-unconfirmed'].includes(caught.connectivityCode) ? caught.connectivityCode : 'unavailable';
            return request ? failure(request, code) : { kind: errorKind, ok: false, errorCode: code };
        }
    }
    return Object.freeze({ invoke,
        // Trusted Main cleanup hooks only, never an IPC authority payload.
        hasRetirementReceipt(authority, producerId) { return retired.has(key(authority, producerId)); },
        authorizeCleanup(event, input, producerId) {
            const value = plain(input, ['toolId', 'streamId', 'bindingId']);
            if (value.toolId !== 'simulator') throw error('permission-denied');
            const authority = Object.freeze({ senderId: event.sender.id, toolId: 'simulator', streamId: id(value.streamId), bindingId: id(value.bindingId) });
            const guard = cleanupGuardFor(event, authority, id(producerId)); return Object.freeze({ authority, guard });
        },
        authorize(event, input) {
            const value = plain(input, ['toolId', 'streamId', 'bindingId']);
            if (value.toolId !== 'simulator') throw error('permission-denied');
            const authority = Object.freeze({ senderId: event.sender.id, toolId: 'simulator', streamId: id(value.streamId), bindingId: id(value.bindingId) });
            const guard = guardFor(event, authority); return Object.freeze({ authority, guard });
        },
        async closeBinding(authority) {
            const results = await Promise.allSettled([...owners.values()].filter(owner => key(owner.authority) === key(authority)).map(closeOwner));
            if (results.some(result => result.status === 'rejected')) throw error('cleanup-unconfirmed');
        },
        async closeSender(senderId) { const results = await Promise.allSettled([...owners.values()].filter(owner => owner.authority.senderId === senderId).map(closeOwner)); if (results.some(result => result.status === 'rejected')) throw error('cleanup-unconfirmed'); },
        async closeRuntime(streamId) { const results = await Promise.allSettled([...owners.values()].filter(owner => owner.authority.streamId === streamId).map(closeOwner)); if (results.some(result => result.status === 'rejected')) throw error('cleanup-unconfirmed'); },
        async dispose() { disposed = true; const results = await Promise.allSettled([...owners.values()].map(closeOwner)); if (results.some(result => result.status === 'rejected') || owners.size) throw error('cleanup-unconfirmed'); retired.clear(); },
        snapshot: () => Object.freeze({ configured, disposed, bindings: owners.size, pending: [...owners.values()].reduce((sum, owner) => sum + owner.pending.size, 0), fenced: [...owners.values()].filter(owner => owner.closed).length,
            retirementReceipts: retired.size, maxRetirementReceipts }),
    });
}
module.exports = { createMainConnectivityHostBoundary };
