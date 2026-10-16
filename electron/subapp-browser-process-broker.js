'use strict';

const { normalizeProcessMessage } = require('./child-process-message-port');
const REQUEST = 'aily-subapp-browser.request', RESULT = 'aily-subapp-browser.result', CANCEL = 'aily-subapp-browser.cancel';
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,96}$/.test(value);
const errorFrame = code => ({ ok: false, errorCode: code, error: code });

/** Registered-process JSON adapter, deliberately no domain operations or event
 * forwarding. Authority is created only by a real main-process owner guard. */
class SubappBrowserProcessBroker {
    constructor({ host, send, resolveStream, timeoutMs = 10000, cancelGraceMs = 3000 }) {
        this.host = host; this.send = send; this.resolveStream = resolveStream;
        this.timeoutMs = timeoutMs; this.cancelGraceMs = cancelGraceMs;
        this.connections = new Map(); this.owners = new Map(); this.pendingCount = 0; this.pendingBytes = 0;
    }

    async bind({ lease, guard, toolId, maxMessageBytes, beforeAdmit, expectedConnectionId }) {
        guard();
        const key = JSON.stringify([lease.runtimeId, lease.executionId, lease.ownerId, lease.leaseId]);
        const existing = this.owners.get(key);
        if (existing) {
            if (existing.retiring) throw new Error('Browser process connection is being revoked');
            if (expectedConnectionId && existing.connection?.connectionId !== expectedConnectionId) throw new Error('Previous Browser owner connection requires confirmed retirement');
            if (existing.admissionFailed && beforeAdmit) existing.opening = this.admit(existing, beforeAdmit);
            const result = await existing.opening; guard();
            if (existing.closed || existing.retiring || !this.host.isCurrent(lease)) throw new Error('Browser process connection ended');
            return { endpoint: { kind: 'browser-message-port', runtimeId: lease.executionId }, connectionId: result.connectionId };
        }
        if (expectedConnectionId) throw new Error('Previous Browser owner connection requires confirmed retirement');
        const stream = this.resolveStream(lease.runtimeId);
        if (!stream || stream.toolId !== toolId || !stream.messagePort || guard.runtime.streamId !== lease.runtimeId) {
            throw new Error('Browser execution requires its registered process message port');
        }
        if (this.owners.size >= 128) throw new Error('Browser process connection limit reached');
        const record = { key, lease, guard, toolId, maxBytes: Math.min(1024 * 1024, maxMessageBytes || 1024 * 1024,
            stream.messagePort.maxMessageBytes || 1024 * 1024), pending: new Map() };
        this.owners.set(key, record);
        try { record.removeCleanup = guard.attachCleanup(() => this.revoke(record)); }
        catch (error) { this.owners.delete(key); throw error; }
        record.opening = (async () => {
            record.connection = await this.host.connectRuntime({ ...lease, guard, onClosed: () => this.ended(record) });
            return this.admit(record, beforeAdmit);
        })();
        try {
            const connection = await record.opening; guard();
            return { endpoint: { kind: 'browser-message-port', runtimeId: lease.executionId }, connectionId: connection.connectionId };
        } catch (error) {
            // A failed private Node ACK keeps this exact Main-held connection
            // for retry; minting another connection would replace its binding.
            if (!record.admissionFailed) await this.revoke(record);
            throw error;
        }
    }

    async admit(record, beforeAdmit) {
        record.admissionFailed = false;
        try { await beforeAdmit?.(record.connection.connectionId); }
        catch (error) { record.admissionFailed = true; throw error; }
        const { lease, guard, connection } = record; guard();
            if (record.retiring || record.closed || !this.host.isCurrent(lease)) throw new Error('Browser process connection ended during binding');
            this.connections.set(connection.connectionId, record);
            connection.port.on('message', ({ data, ports = [] }) => {
                if (ports.length) { for (const port of ports) port.close(); void this.revoke(record).catch(() => {}); return; }
                this.result(record, data);
            });
            connection.port.on('close', () => { if (!record.closed && !record.retiring) void this.revoke(record).catch(() => {}); });
            connection.port.start();
        return connection;
    }

    handle(streamId, input) {
        if (input?.type !== REQUEST && input?.type !== CANCEL) return false;
        const record = this.connections.get(input.connectionId);
        const stream = this.resolveStream(streamId);
        // Node cannot create an owner, pick another process stream, or turn an
        // opaque runtime id into a connection capability.
        if (!record || record.lease.runtimeId !== streamId || !stream || stream.toolId !== record.toolId
            || input.runtimeId !== record.lease.executionId || record.closed || record.retiring) {
            if (stream && validId(input.requestId)) this.reply(streamId, input, errorFrame('BROWSER_EXECUTION_NOT_AUTHORIZED'), stream.messagePort?.maxMessageBytes);
            return true;
        }
        try {
            record.guard();
            if (!this.host.isCurrent(record.lease)) throw new Error('Execution owner ended');
            const { message, sizeBytes } = normalizeProcessMessage(input, record.maxBytes);
            if (message.version !== 1 || !validId(message.requestId)) throw new Error('Invalid browser process frame');
            if (message.type === CANCEL) { const pending = record.pending.get(message.requestId); if (pending) this.cancel(record, pending, 'BROWSER_EXECUTION_CANCELLED'); return true; }
            if (record.pending.has(message.requestId)) { void this.revoke(record).catch(() => {}); return true; }
            if (!message.payload || Object.getPrototypeOf(message.payload) !== Object.prototype || Array.isArray(message.payload)) throw new Error('Browser payload must be a JSON object');
            const timeoutMs = message.timeoutMs === undefined ? this.timeoutMs : message.timeoutMs;
            if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Browser request deadline out of range');
            if (record.pending.size >= 16 || this.pendingCount >= 64 || this.pendingBytes + sizeBytes > 16 * 1024 * 1024) {
                this.reply(streamId, message, errorFrame('BROWSER_EXECUTION_BUSY'), record.maxBytes); return true;
            }
            const pending = { id: message.requestId, sizeBytes, request: message };
            record.pending.set(pending.id, pending); this.pendingCount++; this.pendingBytes += sizeBytes;
            pending.timer = setTimeout(() => this.cancel(record, pending, 'BROWSER_EXECUTION_TIMEOUT'), timeoutMs);
            record.connection.port.postMessage(message);
        } catch {
            if (validId(input.requestId) && !record.pending.has(input.requestId)) this.reply(streamId, input, errorFrame('BROWSER_EXECUTION_INVALID_REQUEST'), record.maxBytes);
            else void this.revoke(record).catch(() => {});
        }
        return true;
    }

    result(record, input) {
        if (record.closed) return;
        try {
            const { message } = normalizeProcessMessage(input, record.maxBytes);
            if (message.type !== RESULT || message.version !== 1 || message.runtimeId !== record.lease.executionId
                || message.connectionId !== record.connection.connectionId || typeof message.ok !== 'boolean' || !validId(message.requestId)) throw new Error('Invalid browser result');
            const pending = record.pending.get(message.requestId);
            if (!pending) return; // A terminal late reply is never replayed into another operation.
            this.finish(record, pending, pending.cancelCode ? errorFrame(pending.cancelCode) : message);
        } catch { void this.revoke(record).catch(() => {}); }
    }

    cancel(record, pending, code) {
        if (pending.cancelCode || record.closed) return;
        pending.cancelCode = code; clearTimeout(pending.timer);
        try { record.connection.port.postMessage({ type: CANCEL, version: 1, runtimeId: record.lease.executionId,
            connectionId: record.connection.connectionId, requestId: pending.id }); } catch { /* Bounded detach below remains authoritative. */ }
        pending.grace = setTimeout(() => { void this.revoke(record).catch(() => {}); }, this.cancelGraceMs);
    }

    finish(record, pending, outcome) {
        if (!record.pending.delete(pending.id)) return;
        clearTimeout(pending.timer); clearTimeout(pending.grace);
        this.pendingCount--; this.pendingBytes -= pending.sizeBytes;
        if (!pending.reportedUnconfirmed) this.reply(record.lease.runtimeId, pending.request, outcome, record.maxBytes);
    }

    reply(streamId, request, outcome, maxBytes = 1024 * 1024) {
        const frame = { type: RESULT, version: 1, runtimeId: request.runtimeId, connectionId: request.connectionId,
            requestId: request.requestId, ...(outcome.ok === true ? { ok: true, result: outcome.result ?? null }
                : { ok: false, errorCode: String(outcome.errorCode || 'BROWSER_EXECUTION_FAILED').slice(0, 96), error: String(outcome.error || 'Browser request failed').slice(0, 256) }) };
        try {
            const normalized = normalizeProcessMessage(frame, Math.min(1024 * 1024, maxBytes)).message;
            void Promise.resolve(this.send(streamId, normalized)).catch(() => {});
        } catch { /* Never forward an oversized/non-JSON result through process IPC. */ }
    }

    async revoke(record) {
        if (record.closed) return;
        if (record.revoking) return record.revoking;
        record.retiring = true;
        for (const pending of record.pending.values()) this.cancel(record, pending, 'BROWSER_EXECUTION_CLOSED');
        const closing = (async () => {
            const connection = record.connection || await record.opening?.catch(() => null);
            if (connection && !record.closed) await connection.close(); // Requires execution detach ACK.
            this.ended(record);
        })();
        record.revoking = closing;
        try { return await closing; }
        catch (error) {
            // Keep cleanup capability, pending budgets and owner records retryable.
            // Sending cancel is never an acknowledgement that the operation stopped.
            for (const pending of record.pending.values()) {
                clearTimeout(pending.grace); pending.grace = null;
                if (!pending.reportedUnconfirmed) { pending.reportedUnconfirmed = true;
                    this.reply(record.lease.runtimeId, pending.request, errorFrame('BROWSER_EXECUTION_CANCEL_UNCONFIRMED'), record.maxBytes); }
            }
            throw error;
        } finally { if (record.revoking === closing) record.revoking = null; }
    }

    ended(record) {
        if (record.closed) return;
        record.closed = true; record.retiring = true;
        for (const pending of [...record.pending.values()]) this.finish(record, pending, errorFrame('BROWSER_EXECUTION_CLOSED'));
        if (record.connection) { record.connection.port.close(); this.connections.delete(record.connection.connectionId); }
        if (this.owners.get(record.key) === record) this.owners.delete(record.key);
        record.removeCleanup?.();
    }
}

module.exports = { SubappBrowserProcessBroker, REQUEST, RESULT, CANCEL };
