const assert = require('node:assert/strict');
const test = require('node:test');
const { acquireOwner, authorizeRestart, releaseOwner } = require('../../electron/child-tool-session-leases');

test('restart is restricted to the sole owner of the exact Runtime stream', () => {
  const session = { streamId: 'stream-v1', owners: new Map() };
  assert.equal(acquireOwner(session, 101, 'window-a').success, true);
  assert.deepEqual(authorizeRestart(session, 101, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }), { success: true });
  assert.equal(authorizeRestart(session, 102, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }).reason, 'shared-runtime-in-use');
  assert.equal(authorizeRestart(session, 101, {
    streamId: 'old-stream', leaseId: 'window-a'
  }).reason, 'stale-session');

  acquireOwner(session, 102, 'window-b');
  assert.equal(authorizeRestart(session, 101, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }).reason, 'shared-runtime-in-use');
  releaseOwner(session, 102, 'window-b');
  assert.equal(authorizeRestart(session, 101, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }).success, true);
});

test('an explicit shared restart requires the current stream and an exact owner lease', () => {
  const session = { streamId: 'shared-stream', owners: new Map() };
  acquireOwner(session, 101, 'background');
  acquireOwner(session, 102, 'standalone');
  const payload = { streamId: 'shared-stream', leaseId: 'standalone', restartShared: true };

  assert.equal(authorizeRestart(session, 102, payload).success, true);
  assert.equal(authorizeRestart(session, 102, { ...payload, restartShared: false }).reason,
    'shared-runtime-in-use');
  assert.equal(authorizeRestart(session, 103, payload).success, false);
  assert.equal(authorizeRestart(session, 102, { ...payload, leaseId: 'background' }).success, false);
  assert.equal(authorizeRestart(session, 102, { ...payload, streamId: 'old-stream' }).reason,
    'stale-session');
  assert.equal(authorizeRestart(session, 102, { ...payload, streamId: '' }).success, false);
  releaseOwner(session, 102, 'standalone');
  assert.equal(authorizeRestart(session, 102, payload).success, false);
});
