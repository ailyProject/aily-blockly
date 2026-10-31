'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { acquireOwner, releaseOwner, ownerCount, hasOwner, ownerKey } = require('./child-tool-session-leases');
const { PROTOCOL, relativeEntry } = require('./subapp-browser-execution-source');
const { createPackagedRendererServer } = require('./packaged-renderer-server');
const { createEmbeddedViewDocument } = require('./subapp-browser-view-document');

const CSP = "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const fault = message => new Error(message);

/** Location metadata is supplied by a Main-only resource provider after its
 * integrity checks. This validates its geometry, not a renderer declaration. */
function resourceLocation(location, source) {
    const origin = new URL(location?.origin);
    const loopback = origin.hostname === 'localhost' || origin.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(origin.hostname);
    if (location.origin !== origin.origin || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) {
        throw fault('Browser execution resource origin must be HTTPS or loopback HTTP');
    }
    if (location.resourceBaseUrl === undefined) {
        if (location.resourceIdentity !== undefined || location.resourcePaths !== undefined || location.resourceSha256 !== undefined) {
            throw fault('Browser execution resource metadata requires a base URL');
        }
        return { origin: origin.origin, resourceBaseUrl: `${origin.origin}/` };
    }
    const base = new URL(location.resourceBaseUrl);
    if (typeof location.resourceBaseUrl !== 'string' || location.resourceBaseUrl.length > 4096
        || location.resourceBaseUrl !== base.href || base.origin !== origin.origin
        || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) {
        throw fault('Browser execution resource base URL is invalid');
    }
    const identity = location.resourceIdentity;
    if (typeof identity !== 'string' || !identity || identity.length > 256 || identity.trim() !== identity
        || /[\u0000-\u001f\u007f]/.test(identity)) throw fault('Browser execution resource identity is invalid');
    if (!Array.isArray(location.resourcePaths) || !location.resourcePaths.length || location.resourcePaths.length > 4096) {
        throw fault('Browser execution requires an explicit bounded resource list');
    }
    const paths = location.resourcePaths.map(relativeEntry);
    if (new Set(paths).size !== paths.length || ![source.entry, ...Object.values(source.surfaces)].every(entry => paths.includes(entry))) {
        throw fault('Browser execution entry and surfaces must belong to its unique resource list');
    }
    let resourceSha256, resourceVersionUrls;
    if (location.resourceSha256 !== undefined) {
        const pins = location.resourceSha256;
        if (!pins || typeof pins !== 'object' || Array.isArray(pins) || Object.keys(pins).length !== paths.length
            || paths.some(entry => !Object.hasOwn(pins, entry) || typeof pins[entry] !== 'string' || !/^[a-f0-9]{64}$/.test(pins[entry]))) {
            throw fault('Browser execution resource pins must match its complete resource list');
        }
        resourceSha256 = Object.freeze(Object.fromEntries(paths.map(entry => [entry, pins[entry]])));
        resourceVersionUrls = Object.freeze(paths.map(entry => {
            const url = new URL(entry, base);
            url.searchParams.set('sha256', resourceSha256[entry]);
            return url.href;
        }));
    }
    return { origin: origin.origin, resourceBaseUrl: base.href, resourceIdentity: identity,
        resourcePaths: Object.freeze(paths), resourceUrls: Object.freeze(paths.map(entry => new URL(entry, base).href)),
        ...(resourceSha256 ? { resourceSha256, resourceVersionUrls } : {}) };
}

/** Hosts documents/leases/ports, never domain sessions or MCU state. The package
 * execution entry owns its existing Runtime and decides its own RPC schema. */
class SubappBrowserExecutionHost {
    constructor({ BrowserWindow, MessageChannelMain, timeoutMs = 10000, createServer, createViewDocument } = {}) {
        this.BrowserWindow = BrowserWindow; this.MessageChannelMain = MessageChannelMain;
        this.createViewDocument = createViewDocument || (input => createEmbeddedViewDocument({ BrowserWindow, ...input }));
        if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw fault('Invalid execution deadline');
        this.timeoutMs = timeoutMs;
        this.createServer = createServer || (entry => createPackagedRendererServer({ indexFile: entry,
            crossOriginIsolated: true, strictPublicFiles: true, contentSecurityPolicy: CSP }));
        this.runtimes = new Map(); this.closed = false;
    }

    async acquire({ runtimeId, source, ownerId, leaseId, guard }) {
        guard();
        if (this.closed || typeof runtimeId !== 'string' || !runtimeId || guard.runtime?.streamId !== runtimeId
            || guard.ownerSessionId !== leaseId || source?.protocol !== PROTOCOL) throw fault('Invalid execution owner');
        let state = this.runtimes.get(runtimeId);
        const key = ownerKey(ownerId, leaseId);
        if (state && (state.source.identity !== source.identity || state.closing || state.failed || state.cancelled || state.retiring.has(key))) {
            throw fault('Browser execution version is pinned until all owners leave');
        }
        if (!state) {
            if (this.runtimes.size >= 32) throw fault('Browser execution domain limit reached');
            state = { runtimeId, source, executionId: randomUUID(), owners: new Map(), bindings: new Map(),
                connections: new Map(), pending: new Map(), sequence: 0, cancelled: false,
                retiring: new Set(), releases: new Map(), ownerHandles: new Map() };
            this.runtimes.set(runtimeId, state);
            // Publish ownership before asynchronous startup so revoke cannot miss it.
        }
        if (ownerCount(state) >= 256 && !hasOwner(state, ownerId, leaseId)) throw fault('Browser execution owner limit reached');
        const lease = acquireOwner(state, ownerId, leaseId);
        if (!lease.success) throw fault('Invalid execution owner lease');
        if (!state.ownerHandles.has(key)) state.ownerHandles.set(key, randomUUID());
        if (!state.bindings.has(key)) {
            try {
                const remove = guard.attachCleanup(() => this.release({ runtimeId, ownerId, leaseId }), { priority: 'execution' });
                state.bindings.set(key, { remove });
            } catch (error) { releaseOwner(state, ownerId, leaseId); state.ownerHandles.delete(key);
                if (!ownerCount(state)) this.runtimes.delete(runtimeId); throw error; }
        }
        if (!state.starting && !state.cancelled) state.starting = this.start(state);
        try {
            await state.starting; guard();
            if (!hasOwner(state, ownerId, leaseId) || state.cancelled) throw fault('Browser execution owner expired during startup');
            return this.describe(state);
        } catch (error) {
            await this.release({ runtimeId, ownerId, leaseId }); throw error;
        }
    }

    describe(state) {
        return { executionId: state.executionId, runtimeId: state.runtimeId, version: state.source.version,
            protocol: PROTOCOL, refCount: ownerCount(state),
            surfaces: Object.fromEntries(Object.entries(state.source.surfaces).map(([name, entry]) => [name, new URL(entry, state.resourceBaseUrl).href])) };
    }

    isCurrent({ runtimeId, executionId, ownerId, leaseId }) {
        const state = this.runtimes.get(runtimeId);
        return Boolean(state && state.executionId === executionId && !state.closing && !state.cancelled && !state.failed
            && !state.retiring.has(ownerKey(ownerId, leaseId)) && hasOwner(state, ownerId, leaseId));
    }

    documentPreferences(state) {
        return {
            preload: path.join(__dirname, 'subapp-browser-execution-preload.js'),
            partition: `subapp-execution-${state.executionId}`, nodeIntegration: false,
            nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
            sandbox: true, contextIsolation: true, webSecurity: true, backgroundThrottling: false,
        };
    }

    createDocument(state) {
        const win = new this.BrowserWindow({ show: false, webPreferences: this.documentPreferences(state) });
        return this.protectDocument(state, win);
    }

    protectDocument(state, win) {
        const contents = win.webContents;
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('will-navigate', event => event.preventDefault());
        contents.on('will-redirect', event => event.preventDefault());
        contents.session?.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        contents.session?.setPermissionCheckHandler(() => false);
        contents.session?.webRequest.onBeforeRequest((details, callback) => {
            let permitted = false;
            try {
                const url = new URL(details.url);
                permitted = url.protocol === 'blob:' ? url.origin === state.origin
                    : url.origin === state.origin && url.pathname.startsWith(new URL(state.resourceBaseUrl).pathname)
                        && (!state.resourceUrls || ['GET', 'HEAD'].includes(details.method) && !url.hash
                            && (state.resourceUrls.includes(url.href) || state.resourceVersionUrls?.includes(url.href) === true));
            } catch { /* Deny malformed and non-owned sources. */ }
            callback({ cancel: !permitted });
        });
        return win;
    }

    async start(state) {
        try {
            state.server = this.createServer(state.source.entry, state.source);
            const location = resourceLocation(await state.server.start({ rootDirectory: state.source.rootDirectory }), state.source);
            Object.assign(state, location, { resolvedIdentity: JSON.stringify([state.source.identity, location.resourceBaseUrl, location.resourceIdentity ?? null]) });
            if (state.cancelled) throw fault('Browser execution startup cancelled');
            const win = state.window = this.createDocument(state);
            const contents = win.webContents;
            const abort = () => {
                if (state.closing) return;
                state.failed = true; state.rejectReady?.(fault('Browser execution document ended'));
                for (const pending of state.pending.values()) pending.reject(fault('Browser execution document ended'));
                void this.close(state).catch(() => {});
            };
            contents.once('destroyed', abort); contents.once('render-process-gone', abort);
            await this.bounded(win.loadURL(new URL(state.source.entry, state.resourceBaseUrl).href), 'Browser execution load');
            if (state.cancelled || win.isDestroyed()) throw fault('Browser execution startup cancelled');
            contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) abort(); });
            const { port1, port2 } = new this.MessageChannelMain(); state.port = port1;
            const ready = new Promise((resolve, reject) => { state.resolveReady = resolve; state.rejectReady = reject; });
            // A synchronous transfer failure must not leave ready as an unhandled rejection.
            void ready.catch(() => {});
            port1.on('message', ({ data }) => {
                try { if (!data || JSON.stringify(data).length > 16384) return; } catch { return; }
                if (data.type === 'ready' && data.protocol === PROTOCOL) state.resolveReady();
                else if (typeof data.id === 'number') {
                    const pending = state.pending.get(data.id);
                    if (pending) { state.pending.delete(data.id); data.ok === true ? pending.resolve(data.value) : pending.reject(fault('Execution lifecycle request failed')); }
                }
            });
            port1.start();
            try {
                contents.postMessage('subapp-browser-execution-port', { protocol: PROTOCOL, role: 'host',
                    executionId: state.executionId, version: state.source.version }, [port2]);
            } catch (error) { port2.close(); throw error; }
            await this.bounded(ready, 'Browser execution ready');
            state.ready = true;
            state.resolveReady = state.rejectReady = null;
        } catch (error) { state.failed = true; throw error; }
    }

    bounded(promise, label) {
        let timer;
        return Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(fault(`${label} deadline exceeded`)), this.timeoutMs);
        })]).finally(() => clearTimeout(timer));
    }

    request(state, type, payload = {}, ports = []) {
        const id = ++state.sequence;
        const promise = new Promise((resolve, reject) => {
            state.pending.set(id, { resolve, reject });
            try { state.port.postMessage({ protocol: PROTOCOL, id, type, ...payload }, ports); }
            catch (error) { state.pending.delete(id); reject(error); }
        });
        return this.bounded(promise, `Browser execution ${type}`).finally(() => state.pending.delete(id));
    }

    async connect(input) { return this.connectEndpoint(input, false); }

    /** Main-only binding over an acknowledged process lease. The real Agent
     * connection is reserved internally before Node learns its identity. */
    async bindNodeOwner({ runtimeId, executionId, ownerId, leaseId, guard, bindingId, bridge }) {
        guard();
        const state = this.runtimes.get(runtimeId), key = ownerKey(ownerId, leaseId), binding = state?.bindings.get(key);
        if (!state || !binding || !this.isCurrent({ runtimeId, executionId, ownerId, leaseId })) throw fault('Browser owner is no longer current');
        const connection = state.connections.get(bindingId);
        if (!connection || connection.key !== key || connection.disconnecting) throw fault('Browser owner binding requires its actual live connection');
        if (binding.node && binding.node.bindingId !== bindingId) throw fault('Previous Browser owner connection requires confirmed retirement');
        if (!binding.node) {
            const owner = guard.processLeaseIdentity();
            if (owner.sessionId !== leaseId) throw fault('Private process lease identity changed');
            binding.node = { streamId: runtimeId, executionId, bindingId, packageName: state.source.packageName,
                packageVersion: state.source.version, owner, releaseId: randomUUID() };
            binding.bridge = bridge;
        }
        await binding.bridge.bind(binding.node); guard();
        if (!this.isCurrent({ runtimeId, executionId, ownerId, leaseId })) throw fault('Browser owner ended during Node binding');
    }

    /** Main-only registered-process broker endpoint. Never serialized to IPC. */
    async connectRuntime(input) { return this.connectEndpoint({ ...input, purpose: 'agent' }, true); }

    /** Registered Node process only. This private lifecycle delivery is never a
     * Renderer IPC action and cannot choose keys, configuration or a subject. */
    async refreshRuntimeAuthorization({ runtimeId, executionId, ownerId, leaseId, guard, connectionId, response }) {
        guard();
        const state = this.runtimes.get(runtimeId), key = ownerKey(ownerId, leaseId);
        const current = () => {
            guard();
            const connection = state?.connections.get(connectionId), binding = state?.bindings.get(key);
            if (!this.isCurrent({ runtimeId, executionId, ownerId, leaseId }) || !connection || connection.key !== key
                || connection.disconnecting || binding?.node?.nodeBound !== true || binding.node.bindingId !== connectionId) {
                throw fault('Signed refresh requires the acknowledged current Node owner');
            }
        };
        current();
        if (!response || Object.getPrototypeOf(response) !== Object.prototype
            || Object.keys(response).sort().join(',') !== 'configuration,lease,revocations'
            || Buffer.byteLength(JSON.stringify(response), 'utf8') > 448 * 1024) throw fault('Invalid signed refresh delivery');
        await this.request(state, 'authorize', { ownerHandle: state.ownerHandles.get(key), connectionId, response });
        current();
        return null;
    }

    async connectEndpoint({ runtimeId, executionId, ownerId, leaseId, guard, target, purpose = 'agent', surface, onClosed }, internal) {
        guard();
        const state = this.runtimes.get(runtimeId), key = ownerKey(ownerId, leaseId);
        if (!state || state.executionId !== executionId || !state.ready || state.closing || state.failed || state.cancelled || state.retiring.has(key) || !hasOwner(state, ownerId, leaseId)
            || guard.runtime?.streamId !== runtimeId || guard.ownerSessionId !== leaseId
            || !internal && (!target || target.isDestroyed()) || !['agent', 'view'].includes(purpose)) throw fault('Browser execution connection is unavailable');
        if (state.connections.size >= 32) throw fault('Browser execution connection limit reached');
        if (purpose === 'view') {
            const entry = state.source.surfaces[surface];
            if (!entry || target.getURL() !== new URL(entry, state.resourceBaseUrl).href) throw fault('View source or version is not trusted');
        } else if (!internal && target.id !== ownerId) throw fault('Agent port must return to its owning renderer');
        const { port1, port2 } = new this.MessageChannelMain(), connectionId = randomUUID();
        const binding = { key, connectionId, target };
        const ended = () => { void this.disconnect(state, connectionId).catch(() => {}); };
        const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) ended(); };
        binding.remove = internal ? () => { port2.close(); onClosed?.(); } : () => {
            target.removeListener('destroyed', ended); target.removeListener('render-process-gone', ended); target.removeListener('did-start-navigation', navigate);
        };
        if (!internal) { target.once('destroyed', ended); target.once('render-process-gone', ended); target.on('did-start-navigation', navigate); }
        state.connections.set(connectionId, binding);
        try {
            await this.request(state, 'attach', { connectionId, ownerHandle: state.ownerHandles.get(key), purpose,
                ...(surface ? { surface } : {}) }, [port1]);
            guard();
            if (!state.connections.has(connectionId) || binding.disconnecting || state.closing || state.cancelled || state.failed
                || state.retiring.has(key) || !hasOwner(state, ownerId, leaseId) || !internal && target.isDestroyed()) throw fault('Connection ended during attachment');
            if (internal) return { connectionId, executionId: state.executionId, port: port2, close: () => this.disconnect(state, connectionId) };
            target.postMessage('subapp-browser-execution-port', { protocol: PROTOCOL, role: 'connection',
                executionId: state.executionId, connectionId, purpose, version: state.source.version }, [port2]);
            return { connectionId, executionId: state.executionId };
        } catch (error) {
            port2.close(); await this.disconnect(state, connectionId); throw error;
        }
    }

    async openView(input, { show = true, presentation = 'window', parent, bounds, visible = true } = {}) {
        input.guard();
        const state = this.runtimes.get(input.runtimeId);
        if (!state || state.executionId !== input.executionId || !state.source.surfaces[input.surface]
            || !hasOwner(state, input.ownerId, input.leaseId) || state.closing || state.failed || state.cancelled
            || state.retiring.has(ownerKey(input.ownerId, input.leaseId))) throw fault('Browser View owner or surface is unavailable');
        if (!['window', 'embedded'].includes(presentation)) throw fault('Unknown Browser View presentation');
        const win = presentation === 'embedded'
            ? this.protectDocument(state, this.createViewDocument({ parent, bounds, visible, webPreferences: this.documentPreferences(state) }))
            : this.createDocument(state);
        (state.views ||= new Set()).add(win);
        win.once('closed', () => state.views.delete(win));
        try {
            await this.bounded(win.loadURL(new URL(state.source.surfaces[input.surface], state.resourceBaseUrl).href), 'Browser View load');
            const connected = await this.connect({ ...input, target: win.webContents, purpose: 'view' });
            const binding = state.connections.get(connected.connectionId); binding.window = win;
            win.on('close', event => {
                event.preventDefault();
                void this.disconnect(state, connected.connectionId).finally(() => { if (!win.isDestroyed()) win.destroy(); }).catch(() => {});
            });
            if (show) win.show();
            return presentation === 'embedded' ? { ...connected, presentation } : connected;
        } catch (error) { if (!win.isDestroyed()) await this.bounded(Promise.resolve(win.destroy()), 'Browser View close'); throw error; }
    }

    updateView({ runtimeId, executionId, ownerId, leaseId, guard, connectionId }, { bounds, visible }) {
        this.viewConnection({ runtimeId, executionId, ownerId, leaseId, guard, connectionId });
        const binding = this.runtimes.get(runtimeId).connections.get(connectionId);
        if (binding.window.presentation !== 'embedded') throw fault('Only an embedded View supports viewport updates');
        binding.window.update({ bounds, visible });
        return { updated: true };
    }

    async closeView({ runtimeId, executionId, ownerId, leaseId, guard, connectionId }) {
        guard();
        const state = this.runtimes.get(runtimeId), binding = state?.connections.get(connectionId);
        if (!state || state.executionId !== executionId || !binding?.window
            || binding.key !== ownerKey(ownerId, leaseId)) throw fault('View attachment is stale or belongs to another owner');
        await this.disconnect(state, connectionId);
        return { detached: true, physicalClosed: binding.window.isDestroyed() };
    }

    /** Main-only installed View composition. The View cannot supply a target,
     * owner, source URL or cleanup callback through its domain port. */
    viewConnection({ runtimeId, executionId, ownerId, leaseId, guard, connectionId }) {
        const state = this.runtimes.get(runtimeId), binding = state?.connections.get(connectionId);
        const assertCurrent = () => {
            guard();
            if (!this.isCurrent({ runtimeId, executionId, ownerId, leaseId }) || !binding?.window
                || binding.key !== ownerKey(ownerId, leaseId) || state.connections.get(connectionId) !== binding
                || binding.disconnecting || binding.target.isDestroyed()
                || !Object.values(state.source.surfaces).some(entry => binding.target.getURL() === new URL(entry, state.resourceBaseUrl).href)) {
                throw fault('Installed View connection is no longer current');
            }
        };
        assertCurrent();
        return { target: binding.target, assertCurrent, attachCleanup(cleanup) {
            assertCurrent();
            if (typeof cleanup !== 'function') throw new TypeError('View cleanup must be a function');
            (binding.cleanups ||= new Set()).add(cleanup);
            return () => binding.cleanups.delete(cleanup);
        } };
    }

    async disconnect(state, connectionId) {
        const binding = state.connections.get(connectionId);
        if (!binding) return;
        if (binding.disconnecting) return binding.disconnecting;
        binding.disconnecting = (async () => {
            try {
                const owner = state.bindings.get(binding.key);
                // Worker owner cleanup closes its connection peers before its
                // control ACK. Join only that owner's evidence, never release()
                // itself: release subsequently joins this connection cleanup.
                if (owner && (state.retiring.has(binding.key) || owner.confirmation)) {
                    await this.confirmOwnerRelease(state, binding.key, owner);
                }
                const results = await Promise.allSettled([
                    ...[...(binding.cleanups || [])].map(async cleanup => { await cleanup(); binding.cleanups.delete(cleanup); }),
                    ...(!state.closing && !state.failed ? [this.request(state, 'detach', { connectionId })] : []),
                ]);
                const failures = results.filter(result => result.status === 'rejected');
                if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'View connection cleanup was not acknowledged');
                if (binding.window && !binding.window.isDestroyed()) await this.bounded(Promise.resolve(binding.window.destroy()), 'Browser View close');
                binding.remove(); state.connections.delete(connectionId);
            } finally { binding.disconnecting = null; }
        })();
        return binding.disconnecting;
    }

    async release({ runtimeId, ownerId, leaseId }) {
        const state = this.runtimes.get(runtimeId);
        if (!state) return { released: true, refCount: 0 };
        const key = ownerKey(ownerId, leaseId);
        if (state.releases.has(key)) return state.releases.get(key);
        if (!hasOwner(state, ownerId, leaseId) && !state.ownerHandles.has(key)) {
            if (!ownerCount(state) && state.bindings.has(key)) return this.close(state);
            return { released: true, refCount: ownerCount(state) };
        }
        state.retiring.add(key); // Fence held attach and same-owner reacquire before any await.
        const pending = (async () => {
            // A startup with no remaining live owner may be cancelled before the
            // document receives any owner/connection capability.
            if (!state.ready && [...state.owners.keys()].every(owner => state.retiring.has(owner))) return this.close(state);
            await state.starting?.catch(() => {});
            if (state.closing) return state.closing;
            if (state.failed || state.cancelled) return this.close(state);
            // Connection detach is not Chat/Runtime ownership release. A timeout
            // may replace a connection while this owner keeps its MCU running.
            await this.confirmOwnerRelease(state, key, state.bindings.get(key));
            const detached = await Promise.allSettled([...state.connections.values()].filter(binding => binding.key === key)
                .map(binding => this.disconnect(state, binding.connectionId)));
            if (detached.some(result => result.status === 'rejected')) throw fault('Connection detach was not acknowledged');
            releaseOwner(state, ownerId, leaseId); state.ownerHandles.delete(key);
            if (!ownerCount(state)) return this.close(state);
            state.bindings.get(key)?.remove(); state.bindings.delete(key); state.retiring.delete(key);
            return { released: true, refCount: ownerCount(state) };
        })();
        state.releases.set(key, pending);
        try { return await pending; } finally { if (state.releases.get(key) === pending) state.releases.delete(key); }
    }

    confirmOwnerRelease(state, key, binding) {
        if (!binding) return Promise.resolve();
        if (binding.confirmation) return binding.confirmation;
        // Publish before dispatch: a peer-close event can request disconnect
        // while Worker cleanup is still preparing its owner-release ACK.
        const confirmation = Promise.resolve().then(async () => {
            if (!binding.workerReleased) {
                if (state.failed || !state.ready || !state.window || state.window.isDestroyed()) throw fault('Browser Worker owner release is unconfirmed');
                await this.request(state, 'owner-release', { ownerHandle: state.ownerHandles.get(key) });
                binding.workerReleased = true;
            }
            if (binding.node) {
                // A lost bind ACK remains an actual I/O owner until its retry joins.
                await binding.bridge.bind(binding.node);
                await binding.bridge.released(binding.node);
            }
        });
        binding.confirmation = confirmation;
        // Success stays cached until this original binding is removed. Failure
        // retains its Worker/bridge state and allows the same receipt to retry.
        void confirmation.catch(() => {
            if (binding.confirmation === confirmation) binding.confirmation = null;
        });
        return confirmation;
    }

    async close(state) {
        if (state.closing) return state.closing;
        state.cancelled = true;
        state.rejectReady?.(fault('Browser execution closed during startup'));
        state.closing = (async () => {
            // Startup catches do not call close, so this join cannot wait on itself.
            // It also prevents a late server.listen() or loadURL() resurrecting resources.
            await state.starting?.catch(() => {});
            const ownerCleanup = await Promise.allSettled([...state.bindings].filter(([, binding]) => binding.node)
                .map(([key, binding]) => this.confirmOwnerRelease(state, key, binding)));
            const connectionCleanup = await Promise.allSettled([...state.connections.values()].flatMap(binding =>
                [...(binding.cleanups || [])].map(async cleanup => { await cleanup(); binding.cleanups.delete(cleanup); })));
            let acknowledged = false, value;
            try { if (state.port && !state.failed && state.window && !state.window.isDestroyed()) {
                value = await this.request(state, 'shutdown'); acknowledged = true;
            } } catch { /* Physical document teardown remains mandatory and observable. */ }
            for (const pending of state.pending.values()) pending.reject(fault('Browser execution closed'));
            state.pending.clear();
            state.port?.close();
            const viewCleanup = await Promise.allSettled([...(state.views || [])].map(async win => {
                if (!win.isDestroyed()) await this.bounded(Promise.resolve(win.destroy()), 'Browser View close');
            }));
            if (state.window && !state.window.isDestroyed()) state.window.destroy();
            if (state.window && !state.window.isDestroyed()) throw fault('Browser execution physical teardown unconfirmed');
            await state.server?.close();
            const failures = [...ownerCleanup, ...connectionCleanup, ...viewCleanup].filter(result => result.status === 'rejected');
            if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'View Node control cleanup remains owned');
            for (const binding of state.connections.values()) binding.remove();
            state.connections.clear();
            for (const binding of state.bindings.values()) binding.remove();
            state.bindings.clear(); state.owners.clear();
            state.ownerHandles.clear();
            if (this.runtimes.get(state.runtimeId) === state) this.runtimes.delete(state.runtimeId);
            return { released: true, refCount: 0, physicalClosed: true, acknowledged, value };
        })();
        try { return await state.closing; } catch (error) { state.closing = null; throw error; }
    }

    async closeAll() {
        this.closed = true;
        const results = await Promise.allSettled([...this.runtimes.values()].map(state => this.close(state)));
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Browser execution teardown remains unconfirmed');
        return results.map(result => result.value);
    }
    async closeRuntime(runtimeId) { const state = this.runtimes.get(runtimeId); return state ? this.close(state) : undefined; }
}

module.exports = { SubappBrowserExecutionHost, CSP };
