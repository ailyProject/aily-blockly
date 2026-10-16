'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { acquireOwner, releaseOwner, ownerCount, hasOwner, ownerKey } = require('./child-tool-session-leases');
const { PROTOCOL } = require('./subapp-browser-execution-source');
const { createPackagedRendererServer } = require('./packaged-renderer-server');

const CSP = "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const fault = message => new Error(message);

/** Hosts documents/leases/ports, never domain sessions or MCU state. The package
 * execution entry owns its existing Runtime and decides its own RPC schema. */
class SubappBrowserExecutionHost {
    constructor({ BrowserWindow, MessageChannelMain, timeoutMs = 10000, createServer } = {}) {
        this.BrowserWindow = BrowserWindow; this.MessageChannelMain = MessageChannelMain;
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
                const remove = guard.attachCleanup(() => this.release({ runtimeId, ownerId, leaseId }));
                state.bindings.set(key, remove);
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
            surfaces: Object.fromEntries(Object.entries(state.source.surfaces).map(([name, entry]) => [name, `${state.origin}/${entry}`])) };
    }

    isCurrent({ runtimeId, executionId, ownerId, leaseId }) {
        const state = this.runtimes.get(runtimeId);
        return Boolean(state && state.executionId === executionId && !state.closing && !state.cancelled && !state.failed
            && !state.retiring.has(ownerKey(ownerId, leaseId)) && hasOwner(state, ownerId, leaseId));
    }

    createDocument(state) {
        const win = new this.BrowserWindow({ show: false, webPreferences: {
            preload: path.join(__dirname, 'subapp-browser-execution-preload.js'),
            partition: `subapp-execution-${state.executionId}`, nodeIntegration: false,
            nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
            sandbox: true, contextIsolation: true, webSecurity: true, backgroundThrottling: false,
        } });
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
                permitted = url.origin === state.origin || url.protocol === 'blob:' && url.pathname.startsWith(state.origin + '/');
            } catch { /* Deny malformed and non-owned sources. */ }
            callback({ cancel: !permitted });
        });
        return win;
    }

    async start(state) {
        try {
            state.server = this.createServer(state.source.entry);
            const { origin } = await state.server.start({ rootDirectory: state.source.rootDirectory });
            state.origin = origin;
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
            await this.bounded(win.loadURL(`${origin}/${state.source.entry}`), 'Browser execution load');
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

    /** Main-only registered-process broker endpoint. Never serialized to IPC. */
    async connectRuntime(input) { return this.connectEndpoint({ ...input, purpose: 'agent' }, true); }

    async connectEndpoint({ runtimeId, executionId, ownerId, leaseId, guard, target, purpose = 'agent', surface, onClosed }, internal) {
        guard();
        const state = this.runtimes.get(runtimeId), key = ownerKey(ownerId, leaseId);
        if (!state || state.executionId !== executionId || !state.ready || state.closing || state.failed || state.cancelled || state.retiring.has(key) || !hasOwner(state, ownerId, leaseId)
            || guard.runtime?.streamId !== runtimeId || guard.ownerSessionId !== leaseId
            || !internal && (!target || target.isDestroyed()) || !['agent', 'view'].includes(purpose)) throw fault('Browser execution connection is unavailable');
        if (state.connections.size >= 32) throw fault('Browser execution connection limit reached');
        if (purpose === 'view') {
            const entry = state.source.surfaces[surface];
            if (!entry || target.getURL() !== `${state.origin}/${entry}`) throw fault('View source or version is not trusted');
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

    async openView(input, { show = true } = {}) {
        input.guard();
        const state = this.runtimes.get(input.runtimeId);
        if (!state || state.executionId !== input.executionId || !state.source.surfaces[input.surface]
            || !hasOwner(state, input.ownerId, input.leaseId) || state.closing || state.failed || state.cancelled
            || state.retiring.has(ownerKey(input.ownerId, input.leaseId))) throw fault('Browser View owner or surface is unavailable');
        const win = this.createDocument(state);
        (state.views ||= new Set()).add(win);
        win.once('closed', () => state.views.delete(win));
        try {
            await this.bounded(win.loadURL(`${state.origin}/${state.source.surfaces[input.surface]}`), 'Browser View load');
            const connected = await this.connect({ ...input, target: win.webContents, purpose: 'view' });
            const binding = state.connections.get(connected.connectionId); binding.window = win;
            win.on('close', event => {
                event.preventDefault();
                void this.disconnect(state, connected.connectionId).finally(() => { if (!win.isDestroyed()) win.destroy(); }).catch(() => {});
            });
            if (show) win.show();
            return connected;
        } catch (error) { if (!win.isDestroyed()) win.destroy(); throw error; }
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
                || !Object.values(state.source.surfaces).some(entry => binding.target.getURL() === `${state.origin}/${entry}`)) {
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
                const results = await Promise.allSettled([
                    ...[...(binding.cleanups || [])].map(async cleanup => { await cleanup(); binding.cleanups.delete(cleanup); }),
                    ...(!state.closing && !state.failed ? [this.request(state, 'detach', { connectionId })] : []),
                ]);
                const failures = results.filter(result => result.status === 'rejected');
                if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'View connection cleanup was not acknowledged');
                binding.remove(); state.connections.delete(connectionId);
                if (binding.window && !binding.window.isDestroyed()) binding.window.destroy();
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
            const detached = await Promise.allSettled([...state.connections.values()].filter(binding => binding.key === key)
                .map(binding => this.disconnect(state, binding.connectionId)));
            if (detached.some(result => result.status === 'rejected')) throw fault('Connection detach was not acknowledged');
            // Connection detach is not Chat/Runtime ownership release. A timeout
            // may replace a connection while this owner keeps its MCU running.
            await this.request(state, 'owner-release', { ownerHandle: state.ownerHandles.get(key) });
            releaseOwner(state, ownerId, leaseId); state.ownerHandles.delete(key);
            if (!ownerCount(state)) return this.close(state);
            state.bindings.get(key)?.(); state.bindings.delete(key); state.retiring.delete(key);
            return { released: true, refCount: ownerCount(state) };
        })();
        state.releases.set(key, pending);
        try { return await pending; } finally { if (state.releases.get(key) === pending) state.releases.delete(key); }
    }

    async close(state) {
        if (state.closing) return state.closing;
        state.cancelled = true;
        state.rejectReady?.(fault('Browser execution closed during startup'));
        state.closing = (async () => {
            // Startup catches do not call close, so this join cannot wait on itself.
            // It also prevents a late server.listen() or loadURL() resurrecting resources.
            await state.starting?.catch(() => {});
            const connectionCleanup = await Promise.allSettled([...state.connections.values()].flatMap(binding =>
                [...(binding.cleanups || [])].map(async cleanup => { await cleanup(); binding.cleanups.delete(cleanup); })));
            let acknowledged = false, value;
            try { if (state.port && !state.failed && state.window && !state.window.isDestroyed()) {
                value = await this.request(state, 'shutdown'); acknowledged = true;
            } } catch { /* Physical document teardown remains mandatory and observable. */ }
            for (const pending of state.pending.values()) pending.reject(fault('Browser execution closed'));
            state.pending.clear();
            state.port?.close();
            for (const win of state.views || []) if (!win.isDestroyed()) win.destroy();
            if (state.window && !state.window.isDestroyed()) state.window.destroy();
            if (state.window && !state.window.isDestroyed()) throw fault('Browser execution physical teardown unconfirmed');
            await state.server?.close();
            const failures = connectionCleanup.filter(result => result.status === 'rejected');
            if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'View Node control cleanup remains owned');
            for (const binding of state.connections.values()) binding.remove();
            state.connections.clear();
            for (const remove of state.bindings.values()) remove();
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
