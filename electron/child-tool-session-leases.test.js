const assert = require('node:assert/strict');
const test = require('node:test');
const { acquireOwner, authorizeExclusiveRestart, releaseOwner } = require('./child-tool-session-leases');

test('restart is restricted to the sole owner of the exact Runtime stream', () => {
  const session = { streamId: 'stream-v1', owners: new Map() };
  assert.equal(acquireOwner(session, 101, 'window-a').success, true);
  assert.deepEqual(authorizeExclusiveRestart(session, 101, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }), { success: true });
  assert.equal(authorizeExclusiveRestart(session, 102, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }).reason, 'shared-runtime-in-use');
  assert.equal(authorizeExclusiveRestart(session, 101, {
    streamId: 'old-stream', leaseId: 'window-a'
  }).reason, 'stale-session');

  acquireOwner(session, 102, 'window-b');
  assert.equal(authorizeExclusiveRestart(session, 101, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }).reason, 'shared-runtime-in-use');
  releaseOwner(session, 102, 'window-b');
  assert.equal(authorizeExclusiveRestart(session, 101, {
    streamId: 'stream-v1', leaseId: 'window-a'
  }).success, true);
});
