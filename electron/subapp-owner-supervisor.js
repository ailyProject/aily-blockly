'use strict';

const { randomUUID } = require('node:crypto');
const { sendLifecycleRequest } = require('./subapp-lifecycle-rpc');
const { SubappOwnerProcessLeases } = require('./subapp-owner-process-lease');

/** Failover record for renderer-owned Agent resources. No device or UI business logic. */
class SubappOwnerSupervisor {
    constructor({ resolveRuntime, send = sendLifecycleRequest, onError = console.warn, processLeases = new SubappOwnerProcessLeases() }) {
        this.resolveRuntime = resolveRuntime;
        this.send = send;
        this.onError = onError;
        this.renderers = new Map();
        this.pending = new Map();
        this.recoveries = new Set();
        this.processLeases = processLeases;
    }

    connect(contents) {
        if (!contents || contents.isDestroyed()) throw new Error('Subapp owner renderer is unavailable');
        let state = this.renderers.get(contents.id);
        if (!state) {
            state = { generation: randomUUID(), bindings: new Map() };
            this.renderers.set(contents.id, state);
            const invalidate = () => { void this.invalidate(contents.id); };
            contents.on('render-process-gone', invalidate);
            contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
                if (isMainFrame && !isInPlace) invalidate();
            });
            contents.once('destroyed', () => {
                invalidate();
                this.renderers.delete(contents.id);
            });
        }
        return { ok: true, generation: state.generation };
    }

    require(contents, generation) {
        const state = this.renderers.get(contents?.id);
        if (!state || contents.isDestroyed() || generation !== state.generation) {
            throw Object.assign(new Error('Subapp owner renderer generation has ended'), { code: 'SUBAPP_RENDERER_EXPIRED' });
        }
        return state;
    }

    async track(contents, input) {
        const state = this.require(contents, input.generation);
        const ownerSessionId = String(input.ownerSessionId || '').trim();
        if (!ownerSessionId || ownerSessionId.length > 256) throw new Error('Invalid Subapp owner identity');
        // Endpoints and callback methods come only from the registered process,
        // never from an IPC-supplied URL or method.
        const runtime = this.resolveRuntime(String(input.toolId || ''), contents.id);
        if (!runtime) throw new Error('Renderer does not own the registered Subapp Runtime');
        const lifecycle = runtime.hostInfo?.runtimeConfig?.agent?.lifecycle;
        const request = lifecycle?.ownerRelease;
        // Only a native registration can set this marker. Public Runtime JSON
        // never grants a private lifecycle capability.
        const native = runtime.nativeOwnerControl === true;
        if (!native && !request?.method) return { ok: true, tracked: false };
        const url = new URL(runtime.hostInfo.wsUrl);
        if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
            throw new Error('Subapp owner cleanup requires a local Runtime endpoint');
        }
        const key = JSON.stringify([state.generation, ownerSessionId, input.toolId, runtime.streamId]);
        if (!state.bindings.has(key)) {
            if (state.bindings.size >= 4096) throw new Error('Subapp owner supervision limit reached');
            const processLease = !native && lifecycle?.ownerLease ? this.processLeases.create(ownerSessionId) : null;
            const binding = { key, toolId: input.toolId, ownerSessionId, wsUrl: url.href,
                method: request?.method, params: { ...(request?.params || {}) }, native, cleanups: new Set(),
                timeoutMs: Math.max(100, Math.min(30_000, Number(request?.timeoutMs) || 5000)), processLease };
            state.bindings.set(key, binding);
            binding.ready = processLease ? Promise.resolve().then(() => this.send({ ...binding,
                method: lifecycle.ownerLease.method, params: { ...(lifecycle.ownerLease.params || {}), ...processLease },
                timeoutMs: Math.max(100, Math.min(30_000, Number(lifecycle.ownerLease.timeoutMs) || 5000)),
            })) : Promise.resolve();
        }
        const binding = state.bindings.get(key);
        try { await binding.ready; }
        catch (error) {
            const result = await this.cleanup(binding);
            if (result.ok) state.bindings.delete(key);
            throw error;
        }
        this.require(contents, input.generation);
        if (state.bindings.get(key) !== binding || binding.revoked) {
            throw Object.assign(new Error('Subapp owner binding has ended'), { code: 'SUBAPP_RENDERER_EXPIRED' });
        }
        binding.acknowledged = true;
        return { ok: true, tracked: true, ...(binding.processLease ? { context: { leaseFile: binding.processLease.leaseFile } } : {}) };
    }

    async release(contents, input) {
        const state = this.require(contents, input.generation);
        const bindings = [...state.bindings.values()].filter(binding =>
            binding.ownerSessionId === input.ownerSessionId && binding.toolId === input.toolId);
        const results = await Promise.all(bindings.map(binding => this.cleanup(binding)));
        for (let i = 0; i < bindings.length; i++) if (results[i].ok) state.bindings.delete(bindings[i].key);
        return { ok: results.every(result => result.ok), handled: bindings.length > 0,
            errors: results.filter(result => !result.ok).map(result => result.error) };
    }

    async invalidate(rendererId) {
        const state = this.renderers.get(rendererId);
        if (!state) return;
        const bindings = [...state.bindings.values()];
        state.bindings.clear();
        state.generation = randomUUID(); // Fence old document IPC synchronously.
        const recovery = Promise.all(bindings.map(async binding => {
            // Idempotent owner release is retryable; domain commands are never replayed.
            let result;
            for (let attempt = 0; attempt < 3; attempt++) {
                result = await this.cleanup(binding);
                if (result.ok) return;
            }
            this.onError('[subapp-owner] Renderer exit cleanup failed', {
                toolId: binding.toolId, ownerSessionId: binding.ownerSessionId, error: result.error,
            });
        }));
        this.recoveries.add(recovery);
        try { await recovery; } finally { this.recoveries.delete(recovery); }
    }

    /** Native port: pin an acknowledged owner AND its registered Runtime.
     * A caller repeating a session id does not acquire this capability. */
    createOwnerGuard(contents, input) {
        const { generation, ownerSessionId, toolId } = input;
        const state = this.require(contents, generation);
        const streamId = this.resolveRuntime(String(toolId || ''), contents.id)?.streamId;
        const key = JSON.stringify([state.generation, ownerSessionId, toolId, streamId]);
        const binding = state.bindings.get(key);
        const check = () => {
            this.require(contents, generation);
            const current = this.resolveRuntime(String(toolId || ''), contents.id);
            if (!binding || binding.revoked || !binding.acknowledged || state.bindings.get(key) !== binding
                || current?.streamId !== streamId || current?.hostInfo?.wsUrl !== binding.wsUrl) {
                throw Object.assign(new Error('Subapp owner binding has ended'), { code: 'SUBAPP_OWNER_EXPIRED' });
            }
        };
        check();
        return Object.assign(check, { ownerSessionId, runtime: Object.freeze({ streamId, origin: new URL(binding.wsUrl).origin }),
            attachCleanup(cleanup) {
                check();
                if (typeof cleanup !== 'function') throw new TypeError('Native cleanup must be a function');
                binding.cleanups.add(cleanup);
                return () => binding.cleanups.delete(cleanup);
            },
        });
    }

    cleanup(binding) {
        if (this.pending.has(binding.key)) return this.pending.get(binding.key);
        binding.revoked = true;
        const pending = Promise.resolve().then(async () => {
            this.processLeases.revoke(binding.processLease);
            // Acquisition may have reached the Runtime despite a lost reply.
            // Fence the file first, then release after that request settles.
            await binding.ready?.catch(() => {});
            // Join all native cleanup, even if one fails. Keep failed callbacks
            // available to the existing bounded recovery path.
            const results = await Promise.allSettled([...binding.cleanups].map(async cleanup => {
                await cleanup(); binding.cleanups.delete(cleanup);
            }));
            const failure = results.find(result => result.status === 'rejected');
            if (failure) throw failure.reason;
            if (!binding.native) await this.send(binding);
        })
            .then(() => ({ ok: true }), error => ({ ok: false, error: String(error?.message || error) }))
            .finally(() => this.pending.delete(binding.key));
        this.pending.set(binding.key, pending);
        return pending;
    }

    async idle() {
        while (this.pending.size || this.recoveries.size) await Promise.all([...this.pending.values(), ...this.recoveries]);
    }
}

function registerSubappOwnerSupervisor(ipcMain, supervisor) {
    ipcMain.handle('subapp-owner-supervision', async (event, input = {}) => {
        try {
            if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) throw new Error('Subapp ownership requires the main frame');
            switch (input.action) {
                case 'connect': return supervisor.connect(event.sender);
                case 'track': return await supervisor.track(event.sender, input);
                case 'release': return await supervisor.release(event.sender, input);
                case 'dispose':
                    supervisor.require(event.sender, input.generation);
                    await supervisor.invalidate(event.sender.id);
                    return { ok: true };
                default: throw new Error('Unknown Subapp supervision action');
            }
        } catch (error) { return { ok: false, error: String(error.message || error), errorCode: error.code || 'SUBAPP_SUPERVISION_FAILED' }; }
    });
}

module.exports = { SubappOwnerSupervisor, registerSubappOwnerSupervisor };
