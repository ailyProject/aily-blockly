'use strict';

const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');

/** Lifecycle-only transport. It can contact a known Runtime, never discover or spawn one. */
function sendLifecycleRequest(binding) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(binding.wsUrl, { maxPayload: 256 * 1024 });
        const id = `owner-lifecycle-${randomUUID()}`;
        let settled = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.terminate();
            if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(new Error('Subapp lifecycle request timed out')), binding.timeoutMs);
        socket.once('open', () => socket.send(JSON.stringify({ id, method: binding.method, params: binding.params,
            context: { actor: 'agent', actorId: 'subapp-agent-host', sessionId: binding.ownerSessionId } }),
        error => { if (error) finish(error); }));
        socket.on('message', raw => {
            try {
                const reply = JSON.parse(String(raw));
                if (reply.id !== id) return;
                finish(reply.ok === true ? undefined : new Error(String(reply.error || 'Subapp lifecycle request failed')));
            } catch { finish(new Error('Invalid Subapp lifecycle response')); }
        });
        socket.once('error', () => finish(new Error('Subapp lifecycle endpoint unavailable')));
        socket.once('close', () => finish(new Error('Subapp lifecycle connection closed without acknowledgement')));
    });
}

module.exports = { sendLifecycleRequest };
