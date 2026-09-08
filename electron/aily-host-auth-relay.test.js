const assert = require('node:assert/strict');
const test = require('node:test');
const { AilyHostAuthRelay } = require('./aily-host-auth-relay');

function harness(options = {}) {
    const sent = [], replies = [];
    const relay = new AilyHostAuthRelay({ sendToRenderer: value => sent.push(value),
        sendToProcess: (stream, value) => replies.push({stream, ...value}), ...options });
    const request = (operation = 'access-token', id = 'request-1') => relay.handle('aily-chat', 'stream-1', {
        channel: 'aily-host-auth-v1', type: 'request', requestId: id, operation,
    });
    return {relay, sent, replies, request};
}

test('read requests wait for readiness; repeated readiness never duplicates delivery', () => {
    const h = harness();
    h.request();
    assert.equal(h.sent.length, 0);
    h.relay.rendererReady();
    h.relay.rendererReady();
    assert.equal(h.sent.length, 1);
    h.relay.complete(h.sent[0].relayId, {ok:true, authenticated:true, accessToken:'fixture', apiServer:'http://localhost'});
    assert.equal(h.replies.length, 1);
    assert.equal(h.relay.pending.size, 0);
});

test('refresh re-delivers only reads and rejects credentials from the old document', () => {
    const h = harness();
    h.relay.rendererReady();
    h.request();
    const stale = h.sent[0].relayId;
    h.relay.rendererUnavailable();
    assert.equal(h.relay.complete(stale, {ok:true, accessToken:'old'}), false);
    h.relay.rendererReady();
    assert.notEqual(h.sent[1].relayId, stale);
    h.relay.complete(h.sent[1].relayId, {ok:false, errorCode:'AUTH_SIGNED_OUT'});
    assert.equal(h.replies[0].result.errorCode, 'AUTH_SIGNED_OUT');
    assert.equal(h.replies[0].requestId, 'request-1');
});

test('refresh-token and logout are never automatically repeated after navigation', () => {
    for (const operation of ['refresh-access-token', 'logout']) {
        const h = harness();
        h.request(operation);
        assert.equal(h.sent.length, 0);
        assert.equal(h.replies[0].result.errorCode, 'HOST_AUTH_UNAVAILABLE');
        h.relay.rendererReady();
        h.request(operation, 'request-2');
        h.relay.rendererUnavailable();
        h.relay.rendererReady();
        assert.equal(h.sent.length, 1);
        assert.equal(h.replies.length, 2);
        assert.equal(h.relay.pending.size, 0);
    }
});

test('bounded queue and window close release all requests without retaining credentials', () => {
    const h = harness({maxPending:1});
    h.request();
    h.request('access-token', 'request-2');
    assert.equal(h.replies[0].result.errorCode, 'HOST_AUTH_BUSY');
    h.relay.close();
    assert.equal(h.replies[1].result.errorCode, 'HOST_AUTH_UNAVAILABLE');
    assert.equal(h.relay.pending.size, 0);
    h.request('access-token', 'after-close');
    assert.equal(h.replies.at(-1).result.errorCode, 'HOST_AUTH_UNAVAILABLE');
    h.relay.rendererReady();
    assert.equal(h.relay.ready, false);
});

test('original timeout remains bounded across renderer generations', async () => {
    const h = harness({timeoutMs:20});
    h.request();
    h.relay.rendererReady();
    h.relay.rendererUnavailable();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0].result.errorCode, 'HOST_AUTH_TIMEOUT');
    h.relay.rendererReady();
    assert.equal(h.sent.length, 1);
});

test('process exit and renderer send failure release only the affected request', () => {
    const h = harness();
    h.request();
    h.relay.releaseProcess('another-process');
    assert.equal(h.relay.pending.size, 1);
    h.relay.releaseProcess('stream-1');
    h.relay.rendererReady();
    assert.equal(h.sent.length, 0);
    const failed = harness({sendToRenderer:()=>{throw new Error('destroyed renderer');}});
    failed.relay.rendererReady();
    failed.request();
    assert.equal(failed.replies[0].result.errorCode, 'HOST_AUTH_UNAVAILABLE');
    assert.equal(failed.relay.pending.size, 0);
});
