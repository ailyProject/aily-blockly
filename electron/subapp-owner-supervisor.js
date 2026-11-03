'use strict';

const { randomUUID } = require('node:crypto');
const { sendLifecycleRequest } = require('./subapp-lifecycle-rpc');
const { SubappOwnerProcessLeases } = require('./subapp-owner-process-lease');

/** Failover record for renderer-owned Agent resources. No device or UI business logic. */
class SubappOwnerSupervisor {
    constructor({ resolveRuntime, send = sendLifecycleRequest, onError = console.warn, processLeases = new SubappOwnerProcessLeases(), now = Date.now }) {
        this.resolveRuntime = resolveRuntime;
        this.send = send;
        this.onError = onError;
        this.renderers = new Map();
        this.pending = new Map();
        this.recoveries = new Set();
        this.processLeases = processLeases;
        this.requests = new Set();
        this.quitting = false;
        this.shutdownWork = null;
        this.abortReason = null;
        this.now = now;
        this.agentOwners = new Map();
        this.latestAgentOwner = new Map();
    }

    connect(contents) {
        this.requireAdmission();
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
        this.requireAdmission();
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
        // Controlled owners may not acquire resources after retirement, even
        // when a late renderer RPC already passed its old local lease check.
        const controlledOwner = this.agentOwners.get(ownerSessionId);
        if (controlledOwner) {
            const owner = controlledOwner;
            if (owner.senderId !== contents.id || owner.generation !== state.generation
                || owner.state !== 'active' || owner.expiresAt <= this.now()) {
                throw this.ownerError('SUBAPP_OWNER_EXPIRED', 'The original Agent owner is no longer active.');
            }
        }
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
            binding.ready = processLease ? Promise.resolve().then(() => this.request({ ...binding,
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

    /** Main-process issuance is independent of a replaceable renderer registry.
     * Capabilities only travel over the private owner-control RPC, never tools. */
    acquireAgentOwner(contents, input) {
        const state = this.require(contents, input.generation);
        const sessionId = String(input.sessionId || '');
        if (!sessionId || sessionId.length > 256) throw this.ownerError('SUBAPP_SESSION_REQUIRED', 'An exact session is required.');
        const senderPid = contents.getOSProcessId?.();
        if (!Number.isSafeInteger(senderPid) || senderPid <= 0) throw this.ownerError('SUBAPP_RENDERER_EXPIRED', 'Renderer incarnation is unavailable.');
        if (this.agentOwners.size >= 2048) {
            for (const [id, value] of this.agentOwners) {
                // Keep controlled-owner tombstones for this entire sender
                // incarnation. Name prefixes cannot distinguish legacy owners.
                if (value.cleanup === 'confirmed' && !value.cleanupWork
                    && this.renderers.get(value.senderId)?.generation !== value.generation) {
                    this.agentOwners.delete(id);
                    if (this.latestAgentOwner.get(value.sessionKey) === id) this.latestAgentOwner.delete(value.sessionKey);
                    break;
                }
            }
        }
        if (this.agentOwners.size >= 2048) throw this.ownerError('SUBAPP_OWNER_LIMIT', 'Owner evidence capacity is full.');
        const ownerLeaseId = `owner-${randomUUID()}`;
        const record = { ownerLeaseId, sessionId, senderId: contents.id, senderPid, generation: state.generation,
            capability: `owner-control-${randomUUID()}`, expiresAt: this.now() + 45_000,
            sessionKey: JSON.stringify([contents.id, state.generation, sessionId]), state: 'active', cleanup: 'unknown' };
        this.agentOwners.set(ownerLeaseId, record);
        this.latestAgentOwner.set(record.sessionKey, ownerLeaseId);
        return { ok: true, ...this.agentLease(record) };
    }

    requireAgentOwner(contents, input) {
        const state = this.require(contents, input.generation);
        const control = input.ownerControl;
        const owner = this.agentOwners.get(String(input.ownerLeaseId || ''));
        if (!owner || !control || control.version !== 1 || control.capability !== owner.capability
            || control.generation !== owner.generation || control.ownerLeaseId !== owner.ownerLeaseId
            || control.sessionId !== owner.sessionId || input.sessionId !== owner.sessionId
            || owner.senderId !== contents.id || owner.senderPid !== contents.getOSProcessId?.()
            || owner.generation !== state.generation) {
            throw this.ownerError('SUBAPP_OWNER_CONTROL_INVALID', 'The original private owner capability is not valid for this sender incarnation.');
        }
        return owner;
    }

    renewAgentOwner(contents, input) {
        const owner = this.requireAgentOwner(contents, input);
        if (owner.state !== 'active' || owner.expiresAt <= this.now()) throw this.ownerError('SUBAPP_OWNER_EXPIRED', 'The original owner expired.');
        owner.expiresAt = this.now() + 45_000;
        return { ok: true, ...this.agentLease(owner) };
    }

    inspectAgentOwner(contents, input) {
        const owner = this.requireAgentOwner(contents, input);
        return this.agentInspection(owner);
    }

    async retireAgentOwner(contents, input) {
        const owner = this.requireAgentOwner(contents, input);
        await this.retireAgentRecord(owner);
        return { ...this.agentInspection(owner), ok: owner.cleanup === 'confirmed',
            ...(owner.cleanup !== 'confirmed' ? { errorCode: 'SUBAPP_OWNER_CLEANUP_FAILED', error: 'Original Runtime cleanup has not been confirmed.' } : {}) };
    }

    async retireAgentRecord(owner) {
        if (owner.cleanupWork) return owner.cleanupWork;
        if (owner.cleanup === 'confirmed') return;
        // Fence acquisition before taking a snapshot of actual owned resources.
        owner.state = 'retiring'; owner.cleanup = 'pending';
        const state = this.renderers.get(owner.senderId);
        owner.bindings ??= [...(state?.bindings.values() || [])].filter(binding => binding.ownerSessionId === owner.ownerLeaseId);
        owner.cleanupWork = Promise.all(owner.bindings.map(binding => this.cleanup(binding))).then(results => {
            owner.cleanup = results.every(result => result.ok) && owner.bindings.every(binding => binding.cleanups.size === 0)
                ? 'confirmed' : 'failed';
            owner.state = 'retired';
            for (let index = 0; index < owner.bindings.length; index++) {
                const binding = owner.bindings[index];
                if (results[index].ok && state?.bindings.get(binding.key) === binding) state.bindings.delete(binding.key);
            }
        }).finally(() => { owner.cleanupWork = undefined; });
        return owner.cleanupWork;
    }

    async recoverAgentOwner(contents, input) {
        const owner = this.requireAgentOwner(contents, input);
        const nonce = String(input.recoveryRequestId || '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) {
            throw this.ownerError('SUBAPP_OWNER_RECOVERY_REQUEST_INVALID', 'Recovery requires its original private request ID.');
        }
        if (owner.recoveryRequestId && owner.recoveryRequestId !== nonce) throw this.ownerError('SUBAPP_OWNER_RECOVERY_REQUEST_MISMATCH', 'Observe the original recovery request.');
        const latest = this.latestAgentOwner.get(owner.sessionKey);
        if (latest !== owner.ownerLeaseId && latest !== owner.successor?.ownerLeaseId) {
            throw this.ownerError('SUBAPP_OWNER_SUPERSEDED', 'Historical owner credentials cannot change a newer session incarnation.');
        }
        if (owner.successor) {
            const active = owner.successor.state === 'active' && owner.successor.expiresAt > this.now();
            return this.agentRecovery(owner, !active, true);
        }
        if (owner.state === 'active' && owner.expiresAt > this.now()) throw this.ownerError('SUBAPP_OWNER_ACTIVE', 'The original owner is still active.');
        owner.recoveryRequestId = nonce;
        await this.retireAgentRecord(owner);
        this.requireAgentOwner(contents, input);
        if (owner.successor) return this.agentRecovery(owner, owner.successor.expiresAt <= this.now(), true);
        if (this.latestAgentOwner.get(owner.sessionKey) !== owner.ownerLeaseId) {
            throw this.ownerError('SUBAPP_OWNER_SUPERSEDED', 'The session acquired another owner while cleanup was pending.');
        }
        // The renderer joins transport cancellations; the independent native
        // ledger joins all resource-owning cleanup callbacks above.
        if (input.pendingRequests !== 0) throw this.ownerError('SUBAPP_OWNER_PENDING_REQUESTS', 'Original requests have not finished.');
        if (input.rendererCleanupConfirmed !== true || owner.cleanup !== 'confirmed'
            || owner.bindings.some(binding => binding.cleanups.size || this.pending.has(binding.key))) {
            throw this.ownerError('SUBAPP_OWNER_CLEANUP_FAILED', 'Original renderer and Runtime resource cleanup is not confirmed.');
        }
        owner.successor = this.agentOwners.get(this.acquireAgentOwner(contents, { generation: owner.generation, sessionId: owner.sessionId }).ownerLeaseId);
        return this.agentRecovery(owner, false, false);
    }

    agentLease(owner) {
        return { ownerLeaseId: owner.ownerLeaseId, sessionId: owner.sessionId, expiresAt: owner.expiresAt,
            ownerControl: { version: 1, capability: owner.capability, generation: owner.generation,
                ownerLeaseId: owner.ownerLeaseId, sessionId: owner.sessionId } };
    }

    agentInspection(owner) {
        const bindings = owner.bindings || [...(this.renderers.get(owner.senderId)?.bindings.values() || [])]
            .filter(binding => binding.ownerSessionId === owner.ownerLeaseId);
        const pendingRequests = bindings.reduce((count, binding) => count + binding.cleanups.size
            + (this.pending.has(binding.key) ? 1 : 0), 0);
        return { ok: true, version: 1, action: 'inspect', sessionId: owner.sessionId, ownerLeaseId: owner.ownerLeaseId,
            state: owner.state === 'active' && owner.expiresAt <= this.now() ? 'expired' : owner.state,
            cleanup: owner.cleanup, pendingRequests,
            currentOwner: this.latestAgentOwner.get(owner.sessionKey) === owner.ownerLeaseId, leaseExpiresAt: owner.expiresAt,
            recoverable: owner.state === 'retired' && owner.cleanup === 'confirmed' && pendingRequests === 0,
            canRetryCleanup: owner.cleanup === 'failed' };
    }

    agentRecovery(owner, expired, reused) {
        return { ok: !expired, version: 1, action: 'recover', ...this.agentLease(owner.successor),
            ...(expired ? { errorCode: 'SUBAPP_OWNER_RECOVERY_RECEIPT_EXPIRED', error: 'The original acknowledged successor is no longer active.' } : {}),
            cleanup: 'confirmed', pendingRequests: 0, notResumed: true, deviceResourcesRestored: false, reused,
            recoveryReceipt: { version: 1, requestId: owner.recoveryRequestId, sessionId: owner.sessionId,
                previousOwnerLeaseId: owner.ownerLeaseId, ownerLeaseId: owner.successor.ownerLeaseId, domainOperationsReplayed: false } };
    }

    ownerError(code, message) { return Object.assign(new Error(message), { code }); }

    async invalidate(rendererId) {
        const state = this.renderers.get(rendererId);
        if (!state) return [];
        const bindings = [...state.bindings.values()];
        state.bindings.clear();
        const oldGeneration = state.generation;
        state.generation = randomUUID(); // Fence old document IPC synchronously.
        for (const [id, owner] of this.agentOwners) {
            if (owner.senderId !== rendererId || owner.generation !== oldGeneration) continue;
            // Old-generation capabilities can no longer address this sender;
            // actual cleanup remains owned by the captured binding references.
            this.agentOwners.delete(id);
            if (this.latestAgentOwner.get(owner.sessionKey) === id) this.latestAgentOwner.delete(owner.sessionKey);
        }
        const recovery = Promise.all(bindings.map(async binding => {
            // Idempotent owner release is retryable; domain commands are never replayed.
            let result;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (this.abortReason) return { ok: false, error: this.abortReason.message };
                result = await this.cleanup(binding);
                if (result.ok) return result;
            }
            this.onError('[subapp-owner] Renderer exit cleanup failed', {
                toolId: binding.toolId, ownerSessionId: binding.ownerSessionId, error: result.error,
            });
            return result;
        }));
        this.recoveries.add(recovery);
        try { return await recovery; } finally { this.recoveries.delete(recovery); }
    }

    requireAdmission() {
        if (this.quitting) throw Object.assign(new Error('Application is quitting.'), { code: 'SUBAPP_HOST_SHUTTING_DOWN' });
    }

    request(binding) {
        if (this.abortReason) return Promise.reject(this.abortReason);
        const controller = new AbortController();
        this.requests.add(controller);
        return Promise.resolve().then(() => {
            if (this.abortReason) throw this.abortReason;
            return this.send({ ...binding, signal: controller.signal });
        }).finally(() => this.requests.delete(controller));
    }

    /** Terminal host fence. The caller supplies the one global shutdown deadline. */
    shutdown({ signal } = {}) {
        if (this.shutdownWork) return this.shutdownWork;
        this.quitting = true;
        const recoveries = [...this.recoveries];
        const drains = [...this.renderers.keys()].map(id => this.invalidate(id));
        this.shutdownWork = new Promise(resolve => {
            let settled = false;
            const finish = result => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                resolve(result);
            };
            const abort = () => {
                this.abortReason = new Error('Subapp owner cleanup exceeded host shutdown deadline');
                for (const controller of this.requests) controller.abort(this.abortReason);
                finish({ complete: false, errors: [this.abortReason.message], pending: this.pending.size, timedOut: true });
            };
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            Promise.allSettled([...recoveries, ...drains]).then(results => {
                const errors = results.flatMap(result => result.status === 'rejected'
                    ? [String(result.reason?.message || result.reason)]
                    : result.value.filter(row => !row.ok).map(row => row.error));
                finish({ complete: errors.length === 0, errors, pending: this.pending.size, timedOut: false });
            });
        });
        return this.shutdownWork;
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
            if (this.abortReason) throw this.abortReason;
            // Join all native cleanup, even if one fails. Keep failed callbacks
            // available to the existing bounded recovery path.
            const results = await Promise.allSettled([...binding.cleanups].map(async cleanup => {
                await cleanup(); binding.cleanups.delete(cleanup);
            }));
            const failure = results.find(result => result.status === 'rejected');
            if (failure) throw failure.reason;
            if (this.abortReason) throw this.abortReason;
            if (!binding.native) await this.request(binding);
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
                case 'agent-acquire': return supervisor.acquireAgentOwner(event.sender, input);
                case 'agent-renew': return supervisor.renewAgentOwner(event.sender, input);
                case 'agent-inspect': return supervisor.inspectAgentOwner(event.sender, input);
                case 'agent-retire': return await supervisor.retireAgentOwner(event.sender, input);
                case 'agent-recover': return await supervisor.recoverAgentOwner(event.sender, input);
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
