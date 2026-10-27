'use strict';
const { randomUUID } = require('node:crypto');
const { normalizeProcessMessage } = require('./child-process-message-port');
const MAX_BYTES = 32 * 1024;
const TYPES = Object.freeze({ bind: 'aily-subapp-node-control.owner-bind', bound: 'aily-subapp-node-control.owner-bound',
    released: 'aily-subapp-node-control.owner-released', acknowledged: 'aily-subapp-node-control.owner-release-ack' });
const identity = ['type', 'version', 'requestId', 'streamId', 'executionId', 'bindingId'];
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const fault = message => new Error(message);
function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw fault('Invalid private Browser owner fields');
}
function shared(frame) {
    if (frame.version !== 1 || !uuid(frame.requestId) || !uuid(frame.executionId) || !uuid(frame.bindingId)
        || typeof frame.streamId !== 'string' || !/^[A-Za-z0-9:_-]{1,96}$/u.test(frame.streamId)) throw fault('Invalid private Browser owner identity');
}
function validateParentMessage(input) {
    const released = input?.type === TYPES.released;
    if (!released && input?.type !== TYPES.bind) throw fault('Invalid private Browser owner request');
    exact(input, [...identity, 'packageName', 'packageVersion', 'owner', ...(released ? ['releaseId'] : [])]); shared(input);
    exact(input.owner, ['sessionId', 'ownerPid', 'leaseFile']);
    if (!text(input.packageName, 256) || !text(input.packageVersion, 256) || !text(input.owner.sessionId, 256)
        || !text(input.owner.leaseFile, 4096) || !Number.isSafeInteger(input.owner.ownerPid) || input.owner.ownerPid <= 0
        || released && !uuid(input.releaseId)) throw fault('Invalid private Browser owner provenance');
    return normalizeProcessMessage(input, MAX_BYTES).message;
}
function validateRuntimeMessage(input) {
    const acknowledged = input?.type === TYPES.acknowledged;
    if (!acknowledged && input?.type !== TYPES.bound || typeof input?.ok !== 'boolean') throw fault('Invalid private Browser owner acknowledgement');
    exact(input, [...identity, 'sessionId', 'ok', ...(acknowledged ? ['releaseId'] : []), ...(input.ok ? [] : ['errorCode', 'error'])]); shared(input);
    if (!text(input.sessionId, 256) || acknowledged && !uuid(input.releaseId)
        || !input.ok && (!text(input.errorCode, 96) || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(input.errorCode) || !text(input.error, 256))) {
        throw fault('Invalid private Browser owner acknowledgement outcome');
    }
    return normalizeProcessMessage(input, MAX_BYTES).message;
}

/** Pending private process I/O only. Binding/release identity and cleanup
 * responsibility stay in the existing Host and Supervisor owner records. */
class SubappBrowserOwnerBridge {
    constructor({ send, resolveRuntime, timeoutMs = 10000 }) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw fault('Invalid owner evidence deadline');
        Object.assign(this, { send, resolveRuntime, timeoutMs }); this.pending = new Map();
    }
    get pendingCount() { return this.pending.size; }
    bind(binding) { return this.request(binding, 'bind'); }
    released(binding) { return this.request(binding, 'released'); }
    async request(binding, operation) {
        if (operation === 'bind' ? binding.nodeBound : binding.nodeEvidenceAcknowledged) return;
        const runtime = this.resolveRuntime(binding.streamId);
        if (!runtime?.messagePort || runtime.hostInfo?.runtimeConfig?.packageName !== binding.packageName
            || runtime.hostInfo?.runtimeConfig?.version !== binding.packageVersion) throw fault('Registered owner package or Runtime changed');
        const field = operation === 'bind' ? 'bindIO' : 'releaseIO';
        let pending = binding[field];
        if (!pending) {
            if (this.pending.size >= 64) throw fault('Private Browser owner I/O capacity reached');
            const frame = validateParentMessage({ type: TYPES[operation], version: 1, requestId: randomUUID(),
                streamId: binding.streamId, executionId: binding.executionId, bindingId: binding.bindingId,
                packageName: binding.packageName, packageVersion: binding.packageVersion, owner: binding.owner,
                ...(operation === 'released' ? { releaseId: binding.releaseId } : {}) });
            if (Buffer.byteLength(JSON.stringify(frame)) > runtime.messagePort.maxMessageBytes) throw fault('Registered process budget is too small for owner evidence');
            let acknowledge;
            const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
            pending = { frame, acknowledge, acknowledgement, sending: false }; binding[field] = pending;
            this.pending.set(frame.requestId, pending); // Reserve before any actual send.
        }
        // A timed-out request may be retransmitted with the same request id,
        // but never while an earlier actual send callback is still outstanding.
        if (!pending.sending) {
            pending.sending = true;
            pending.sendTask = Promise.resolve().then(() => this.send(binding.streamId, pending.frame)).then(result => {
                if (result?.success !== true) throw fault('Registered owner IPC send was not acknowledged');
            }).finally(() => { pending.sending = false; });
        }
        let timer;
        try {
            const [ack] = await Promise.race([Promise.all([pending.acknowledgement, pending.sendTask]), new Promise((_, reject) => {
                timer = setTimeout(() => reject(fault('Private Browser owner ACK deadline exceeded')), this.timeoutMs);
            })]);
            this.pending.delete(pending.frame.requestId); binding[field] = null;
            if (!ack.ok) throw Object.assign(fault(ack.error), { code: ack.errorCode });
            if (operation === 'bind') binding.nodeBound = true; else binding.nodeEvidenceAcknowledged = true;
        } finally { clearTimeout(timer); }
    }
    handle(streamId, input) {
        if (![TYPES.bound, TYPES.acknowledged].includes(input?.type)) return false;
        const pending = this.pending.get(input.requestId);
        if (!pending || pending.frame.streamId !== streamId) return true;
        let frame;
        try { frame = validateRuntimeMessage(input); } catch { return true; }
        const source = pending.frame;
        if (frame.type !== (source.type === TYPES.bind ? TYPES.bound : TYPES.acknowledged)
            || frame.streamId !== source.streamId || frame.executionId !== source.executionId || frame.bindingId !== source.bindingId
            || frame.sessionId !== source.owner.sessionId || frame.releaseId !== source.releaseId) return true;
        pending.acknowledge(frame); return true;
    }
}
module.exports = { SubappBrowserOwnerBridge, TYPES, MAX_BYTES, validateParentMessage, validateRuntimeMessage };
