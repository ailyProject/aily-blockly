'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once, getEventListeners } = require('node:events');
const { WebSocketServer } = require('ws');
const { sendLifecycleRequest } = require('../../electron/subapp-lifecycle-rpc');

async function endpoint(t) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    t.after(async () => {
        for (const socket of server.clients) socket.terminate();
        await new Promise(resolve => server.close(resolve));
    });
    return { server, binding: { wsUrl: `ws://127.0.0.1:${server.address().port}/?token=test-only`,
        method: 'fixture.release', ownerSessionId: 'owner', params: {}, timeoutMs: 5000 } };
}

test('pre-aborted lifecycle request rejects before opening a socket', async () => {
    const controller = new AbortController(); controller.abort();
    // An invalid URL would throw if the transport tried constructing WebSocket.
    await assert.rejects(sendLifecycleRequest({ wsUrl: 'invalid-url', signal: controller.signal }), /request aborted/);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('deadline abort closes an active lifecycle socket and cannot count as ACK', async t => {
    const fixture = await endpoint(t), controller = new AbortController();
    const connected = once(fixture.server, 'connection');
    const work = sendLifecycleRequest({ ...fixture.binding, signal: controller.signal });
    const rejected = assert.rejects(work, /request aborted/);
    const [socket] = await connected;
    const closed = once(socket, 'close');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort();
    await Promise.all([rejected, closed]);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('only an actual matching successful reply acknowledges release and removes abort listener', async t => {
    const fixture = await endpoint(t), controller = new AbortController();
    fixture.server.on('connection', socket => socket.on('message', raw => {
        const request = JSON.parse(String(raw));
        socket.send(JSON.stringify({ id: 'unrelated', ok: true }));
        socket.send(JSON.stringify({ id: request.id, ok: true }));
    }));
    await sendLifecycleRequest({ ...fixture.binding, signal: controller.signal });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort(); // A later global timeout cannot relabel an observed ACK.
});
