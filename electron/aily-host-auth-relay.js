const { randomUUID } = require('node:crypto');
const {
    AILY_HOST_AUTH_CHANNEL,
    normalizeAilyHostAuthResult,
    parseAilyHostAuthRequest,
} = require('./aily-host-auth-process-bridge');

// The main process owns pending requests; renderer refresh cannot own their lifetime.
class AilyHostAuthRelay {
    constructor({ sendToRenderer, sendToProcess, timeoutMs = 15000, maxPending = 128 }) {
        this.sendToRenderer = sendToRenderer;
        this.sendToProcess = sendToProcess;
        this.timeoutMs = timeoutMs;
        this.maxPending = maxPending;
        this.pending = new Map();
        this.ready = false;
        this.closed = false;
    }

    reply(request, result) {
        void this.sendToProcess(request.streamId, {
            channel: AILY_HOST_AUTH_CHANNEL, type: 'response', requestId: request.requestId,
            result: normalizeAilyHostAuthResult(result),
        });
    }

    handle(toolId, streamId, message) {
        const parsed = parseAilyHostAuthRequest(toolId, message);
        if (!parsed.handled) return false;
        const request = { ...parsed, streamId, relayId: randomUUID() };
        if (!parsed.valid) {
            this.reply(request, parsed.result);
            return true;
        }
        if (this.closed || (!this.ready && parsed.operation !== 'access-token')) {
            this.reply(request, { ok: false, errorCode: 'HOST_AUTH_UNAVAILABLE' });
            return true;
        }
        while (this.pending.size >= this.maxPending) {
            this.complete(this.pending.keys().next().value, { ok: false, errorCode: 'HOST_AUTH_BUSY' });
        }
        request.timer = setTimeout(() => this.complete(request.relayId, {
            ok: false, errorCode: 'HOST_AUTH_TIMEOUT', message: 'The host authentication request timed out',
        }), this.timeoutMs);
        this.pending.set(request.relayId, request);
        if (this.ready) this.deliver(request);
        return true;
    }

    deliver(request) {
        try {
            this.sendToRenderer({ relayId: request.relayId, operation: request.operation,
                ...(request.rejectedGeneration !== undefined ? { rejectedGeneration: request.rejectedGeneration } : {}),
            });
        } catch {
            this.complete(request.relayId, { ok: false, errorCode: 'HOST_AUTH_UNAVAILABLE' });
        }
    }

    rendererReady() {
        if (this.ready || this.closed) return;
        this.ready = true;
        for (const request of this.pending.values()) this.deliver(request);
    }

    rendererUnavailable() {
        this.ready = false;
        for (const [relayId, request] of [...this.pending]) {
            if (request.operation !== 'access-token') {
                this.complete(relayId, { ok: false, errorCode: 'HOST_AUTH_UNAVAILABLE' });
                continue;
            }
            // Rotate the delivery identity so an old document cannot return a stale credential.
            this.pending.delete(relayId);
            request.relayId = randomUUID();
            this.pending.set(request.relayId, request);
        }
    }

    complete(relayId, result) {
        const request = this.pending.get(relayId);
        if (!request) return false;
        clearTimeout(request.timer);
        this.pending.delete(relayId);
        this.reply(request, result);
        return true;
    }

    close() {
        this.closed = true;
        this.ready = false;
        for (const id of this.pending.keys()) {
            this.complete(id, { ok: false, errorCode: 'HOST_AUTH_UNAVAILABLE' });
        }
    }

    releaseProcess(streamId) {
        for (const [id, request] of this.pending) {
            if (request.streamId !== streamId) continue;
            clearTimeout(request.timer);
            this.pending.delete(id);
        }
    }
}

module.exports = { AilyHostAuthRelay };
