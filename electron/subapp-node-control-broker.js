'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeProcessMessage } = require('./child-process-message-port');
const { PROTOCOL } = require('./subapp-node-control-source');
const TYPES = Object.freeze(Object.fromEntries(['attach', 'attached', 'request', 'result', 'cancel', 'detach', 'detached', 'dispose', 'disposed']
    .map(name => [name, `aily-subapp-node-control.${name}`])));
const MAX_BYTES = 1024 * 1024;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,96}$/.test(value);
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identityKeys = ['type', 'version', 'runtimeId', 'connectionId', 'requestId'];
const failure = (code, message) => Object.assign(new Error(message), { code });

/** A low-frequency transport for a Main-authorized installed View. It owns no
 * domain methods, Sessions, process-controller leases or execution engines. */
class SubappNodeControlBroker {
    constructor({ MessageChannelMain, send, resolveRuntime, timeoutMs = 10000, cancelGraceMs = 3000 }) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000
            || !Number.isInteger(cancelGraceMs) || cancelGraceMs < 10 || cancelGraceMs > 3000) throw new Error('Invalid Node control deadline');
        Object.assign(this, { MessageChannelMain, send, resolveRuntime, timeoutMs, cancelGraceMs });
        this.connections = new Map(); this.pendingCount = 0; this.pendingBytes = 0;
    }

    /** Synchronous ownership publication lets Host register close before the
     * first Node attach can yield. Only trusted composition calls this method. */
    connectView({ lease, guard, source, target, assertCurrent, browserExecution }) {
        guard(); assertCurrent();
        const runtime = this.resolveRuntime(lease.runtimeId);
        if (!runtime?.messagePort || source?.protocol !== PROTOCOL || this.connections.size >= 128
            || guard.runtime?.streamId !== lease.runtimeId || guard.ownerSessionId !== lease.leaseId
            || !validId(lease.executionId) || !target || target.isDestroyed()) throw new Error('Registered Node control is unavailable');
        const maxBytes = Math.min(MAX_BYTES, source.maxMessageBytes, runtime.messagePort.maxMessageBytes);
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error('Invalid registered Node control budget');
        const { port1, port2 } = new this.MessageChannelMain();
        const record = { lease, guard, source, target, assertCurrent, connectionId: randomUUID(), runtimeId: lease.executionId,
            maxBytes,
            port: port1, deliveredPort: port2, controls: new Map(), pending: new Map(), seen: new Set(), sends: new Set(), active: true };
        this.connections.set(record.connectionId, record);
        const revoke = () => { void this.close(record).catch(() => {}); };
        const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) revoke(); };
        try { record.removeCleanup = guard.attachCleanup(() => this.close(record)); }
        catch (error) { this.connections.delete(record.connectionId); port1.close(); port2.close(); throw error; }
        target.once('destroyed', revoke); target.once('render-process-gone', revoke); target.on('did-start-navigation', navigate);
        record.removeTarget = () => {
            target.removeListener('destroyed', revoke); target.removeListener('render-process-gone', revoke);
            target.removeListener('did-start-navigation', navigate);
        };
        port1.on('message', ({ data, ports = [] }) => {
            if (ports.length) { for (const port of ports) port.close(); revoke(); return; }
            this.fromView(record, data);
        });
        port1.on('messageerror', revoke); port1.start();
        record.opening = Promise.resolve().then(async () => {
            this.current(record);
            record.attachSent = true;
            await this.control(record, 'attach', { packageName: source.packageName, packageVersion: source.version, purpose: 'view',
                context: { actor: 'view', sessionId: lease.leaseId, ...(browserExecution ? { browserExecution } : {}) } });
        });
        const ready = record.opening.then(() => {
            this.current(record);
            target.postMessage('subapp-node-control-port', { protocol: PROTOCOL, version: 1, role: 'view',
                runtimeId: record.runtimeId, connectionId: record.connectionId,
                packageName: source.packageName, packageVersion: source.version }, [port2]);
            record.delivered = true;
            return { connectionId: record.connectionId };
        }).catch(async error => {
            try { await this.close(record); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Node control cleanup requires retry'); }
            throw error;
        });
        // The caller owns ready, including its rejection. Cleanup only joins
        // opening, so a failed handoff cannot wait on its own catch handler.
        return { ready, close: () => this.close(record), connectionId: record.connectionId };
    }

    current(record) {
        record.guard(); record.assertCurrent();
        const runtime = this.resolveRuntime(record.lease.runtimeId);
        if (!record.active || record.closed || !runtime?.messagePort || record.target.isDestroyed()) throw new Error('Node control owner ended');
    }

    async sendFrame(record, frame) {
        const normalized = normalizeProcessMessage(frame, record.maxBytes).message;
        const task = Promise.resolve().then(() => this.send(record.lease.runtimeId, normalized)).then(result => {
            if (result?.success !== true) throw failure('NODE_CONTROL_SEND_FAILED', 'Registered Node IPC send was not acknowledged');
        });
        record.sends.add(task);
        void task.then(() => record.sends.delete(task), () => record.sends.delete(task));
        await this.bounded(task, 'Registered Node send callback timed out');
    }

    bounded(task, message) {
        let timer;
        return Promise.race([task, new Promise((_, reject) => {
            timer = setTimeout(() => reject(failure('NODE_CONTROL_CLEANUP_UNCONFIRMED', message)), this.timeoutMs);
        })]).finally(() => clearTimeout(timer));
    }

    control(record, operation, payload = {}) {
        const requestId = randomUUID(), frame = { type: TYPES[operation], version: 1,
            runtimeId: record.runtimeId, connectionId: record.connectionId, requestId, ...payload };
        let timer;
        const response = new Promise((resolve, reject) => {
            timer = setTimeout(() => { record.controls.delete(requestId); reject(failure('NODE_CONTROL_CLEANUP_UNCONFIRMED', 'Node control lifecycle ACK timed out')); }, this.timeoutMs);
            record.controls.set(requestId, { operation, resolve, reject });
        });
        return Promise.all([response, this.sendFrame(record, frame)]).then(() => undefined).finally(() => {
            clearTimeout(timer); record.controls.delete(requestId);
        });
    }

    fromView(record, input) {
        let frame;
        try {
            this.current(record);
            frame = normalizeProcessMessage(input, record.maxBytes).message;
            if (frame.version !== 1 || frame.runtimeId !== record.runtimeId || frame.connectionId !== record.connectionId || !validId(frame.requestId)) throw new Error('Invalid Node control identity');
            if (frame.type === TYPES.cancel) {
                if (!exact(frame, identityKeys)) throw new Error('Invalid Node control cancel');
                const pending = record.pending.get(frame.requestId); if (pending) this.cancel(record, pending);
                return;
            }
            if (frame.type === TYPES.dispose) {
                if (!exact(frame, identityKeys)) throw new Error('Invalid Node control dispose');
                void this.close(record, frame.requestId).catch(() => {}); return;
            }
            if (frame.type !== TYPES.request || !exact(frame, [...identityKeys, 'timeoutMs', 'payload'])
                || !Number.isInteger(frame.timeoutMs) || frame.timeoutMs < 100 || frame.timeoutMs > (frame.payload?.operation === 'runtime'
                    && ['start', 'recover'].includes(frame.payload.action) ? 300000 : 30000)
                || !frame.payload || Object.getPrototypeOf(frame.payload) !== Object.prototype) throw new Error('Invalid Node control request');
            if (record.seen.has(frame.requestId) || record.controls.has(frame.requestId)) throw new Error('Repeated Node control request identity');
            if (record.pending.size >= 16 || this.pendingCount >= 64 || this.pendingBytes + Buffer.byteLength(JSON.stringify(frame)) > 16 * MAX_BYTES || record.seen.size >= 65536) {
                this.reply(record, frame.requestId, { ok: false, errorCode: 'NODE_CONTROL_BUSY', error: 'Node control capacity reached' }); return;
            }
            record.seen.add(frame.requestId);
            const pending = { requestId: frame.requestId, bytes: Buffer.byteLength(JSON.stringify(frame)), sends: 0 };
            record.pending.set(frame.requestId, pending); this.pendingCount++; this.pendingBytes += pending.bytes;
            pending.timer = setTimeout(() => this.cancel(record, pending), frame.timeoutMs);
            this.requestSend(record, pending, frame);
        } catch (error) {
            if (validId(input?.requestId)) this.reply(record, input.requestId, { ok: false, errorCode: 'NODE_CONTROL_INVALID_REQUEST', error: String(error.message).slice(0, 256) });
        }
    }

    requestSend(record, pending, frame) {
        pending.sends++;
        void this.sendFrame(record, frame).then(() => {
            pending.sends--; this.complete(record, pending);
        }, () => {
            pending.sends--;
            pending.failure = true;
            void this.close(record).catch(() => {});
        });
    }

    cancel(record, pending) {
        if (pending.cancelled) return;
        pending.cancelled = true; clearTimeout(pending.timer);
        this.requestSend(record, pending, { type: TYPES.cancel, version: 1, runtimeId: record.runtimeId,
            connectionId: record.connectionId, requestId: pending.requestId });
        pending.grace = setTimeout(() => { void this.close(record).catch(() => {}); }, this.cancelGraceMs);
    }

    /** Reserved ingress runs before the existing single-controller relay. */
    handle(streamId, input) {
        if (typeof input?.type !== 'string' || !input.type.startsWith('aily-subapp-node-control.')) return false;
        if (!Object.values(TYPES).includes(input.type)) return true;
        const record = this.connections.get(input?.connectionId);
        if (!record || record.lease.runtimeId !== streamId) return true;
        try {
            const frame = normalizeProcessMessage(input, record.maxBytes).message;
            if (frame.version !== 1 || frame.runtimeId !== record.runtimeId || !validId(frame.requestId)) throw new Error('Invalid Node control result identity');
            const control = record.controls.get(frame.requestId);
            if (control) {
                if (frame.type !== TYPES[control.operation === 'attach' ? 'attached' : 'detached']) throw new Error('Wrong Node control lifecycle result');
                this.validateOutcome(frame, false);
                if (frame.ok) control.resolve(); else control.reject(failure(frame.errorCode, frame.error));
                return true;
            }
            if (frame.type !== TYPES.result) return true;
            const pending = record.pending.get(frame.requestId); if (!pending) return true;
            this.validateOutcome(frame, true);
            if (!pending.terminal) pending.terminal = frame;
            this.complete(record, pending);
        } catch (error) {
            for (const control of record.controls.values()) control.reject(error);
            void this.close(record).catch(() => {});
        }
        return true;
    }

    validateOutcome(frame, result) {
        const keys = frame.ok === true ? [...identityKeys, 'ok', ...(result ? ['result'] : [])] : [...identityKeys, 'ok', 'errorCode', 'error'];
        if (typeof frame.ok !== 'boolean' || !exact(frame, keys) || frame.ok === false
            && (typeof frame.errorCode !== 'string' || frame.errorCode.length > 96 || typeof frame.error !== 'string' || frame.error.length > 256)) throw new Error('Invalid Node control outcome');
    }

    complete(record, pending) {
        if (!pending.terminal || pending.sends || pending.failure || !record.pending.has(pending.requestId)) return;
        this.finish(record, pending, pending.cancelled ? { ok: false, errorCode: 'NODE_CONTROL_CANCELLED', error: 'Node request cancelled' } : pending.terminal);
    }

    finish(record, pending, outcome) {
        if (!record.pending.delete(pending.requestId)) return;
        clearTimeout(pending.timer); clearTimeout(pending.grace);
        this.pendingCount--; this.pendingBytes -= pending.bytes;
        if (!pending.unconfirmed) this.reply(record, pending.requestId, outcome);
    }

    reply(record, requestId, outcome, type = TYPES.result) {
        try {
            const frame = { type, version: 1, runtimeId: record.runtimeId, connectionId: record.connectionId, requestId,
                ...(outcome.ok === true ? { ok: true, ...(type === TYPES.result ? { result: outcome.result ?? null } : {}) }
                    : { ok: false, errorCode: String(outcome.errorCode || 'NODE_CONTROL_FAILED').slice(0, 96), error: String(outcome.error || 'Node control failed').slice(0, 256) }) };
            record.port.postMessage(normalizeProcessMessage(frame, record.maxBytes).message);
        } catch { /* Ownership is retained until Node lifecycle cleanup ACK. */ }
    }

    close(record, disposeRequestId) {
        if (record.closed) return Promise.resolve();
        if (record.closing) return record.closing;
        record.active = false;
        for (const pending of record.pending.values()) this.cancel(record, pending);
        record.closing = (async () => {
            await record.opening.catch(() => {});
            if (record.attachSent) await this.control(record, 'detach');
            await this.bounded(Promise.allSettled([...record.sends]), 'Node IPC callbacks remain unconfirmed');
            // A private detach ACK is terminal for this exact connection,
            // including a request whose individual result could not arrive.
            for (const pending of [...record.pending.values()]) this.finish(record, pending, { ok: false, errorCode: 'NODE_CONTROL_CLOSED', error: 'Node control connection closed' });
            if (disposeRequestId) this.reply(record, disposeRequestId, { ok: true }, TYPES.disposed);
            this.remove(record);
        })().catch(error => {
            if (record.exited) { for (const pending of [...record.pending.values()]) this.finish(record, pending,
                { ok: false, errorCode: 'NODE_CONTROL_CLOSED', error: 'Registered Node Runtime exited' }); this.remove(record); return; }
            for (const pending of record.pending.values()) {
                clearTimeout(pending.grace);
                if (!pending.unconfirmed) { pending.unconfirmed = true; this.reply(record, pending.requestId,
                    { ok: false, errorCode: 'NODE_CONTROL_CLEANUP_UNCONFIRMED', error: 'Node cleanup is unconfirmed; Host retains responsibility' }); }
            }
            if (disposeRequestId) this.reply(record, disposeRequestId, { ok: false, errorCode: 'NODE_CONTROL_CLEANUP_UNCONFIRMED', error: 'Node control cleanup requires retry' }, TYPES.disposed);
            throw error;
        }).finally(() => { record.closing = null; });
        return record.closing;
    }

    remove(record) {
        record.port.close(); if (!record.delivered) record.deliveredPort.close();
        record.removeTarget(); record.removeCleanup(); record.closed = true;
        this.connections.delete(record.connectionId);
    }

    async closeRuntime(streamId) {
        const results = await Promise.allSettled([...this.connections.values()].filter(record => record.lease.runtimeId === streamId).map(record => this.close(record)));
        const failed = results.filter(result => result.status === 'rejected'); if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Node control cleanup remains owned');
    }

    async closeAll() {
        const results = await Promise.allSettled([...this.connections.values()].map(record => this.close(record)));
        const failed = results.filter(result => result.status === 'rejected'); if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Node control cleanup remains owned');
    }

    runtimeExited(streamId) {
        for (const record of this.connections.values()) if (record.lease.runtimeId === streamId) {
            record.exited = true; record.attachSent = false;
            for (const control of record.controls.values()) control.reject(new Error('Registered Node Runtime exited'));
            void this.close(record).catch(() => {});
        }
    }
}

module.exports = { SubappNodeControlBroker, TYPES, PROTOCOL };
