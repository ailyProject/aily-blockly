const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { buildSync } = require('esbuild');
const compiled = buildSync({ stdin: { contents: `export {SubappAgentOwnerLeases} from './src/app/services/integrations/subapps/models/subapp-agent-owner-leases';
  export {SubappOwnerRequests} from './src/app/services/integrations/subapps/models/subapp-owner-requests';`,
  resolveDir: path.resolve(__dirname, '../..'), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs' });
const model = new Module(__filename, module);
model._compile(compiled.outputFiles[0].text, __filename);
const { SubappAgentOwnerLeases, SubappOwnerRequests } = model.exports;
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
function fixture(t, onRelease = async () => ({ ok: true })) {
  let now = 1000;
  const requests = new SubappOwnerRequests(), calls = [];
  const leases = new SubappAgentOwnerLeases(async lease => { calls.push(lease); return onRelease(lease); },
    () => now, id => requests.pendingCount(id));
  t.after(() => { requests.stop(); leases.stop(); });
  return { leases, requests, calls, expire: () => { now = 46000; }, advance: value => { now = value; } };
}

test('active, foreign and unknown owners cannot authorize a successor', t => {
  const f = fixture(t), owner = f.leases.acquire('session-a');
  assert.equal(f.leases.inspect(owner.ownerLeaseId, 'session-a').state, 'active');
  assert.equal(f.leases.recover(owner.ownerLeaseId, 'session-a', randomUUID()).errorCode, 'SUBAPP_OWNER_ACTIVE');
  assert.throws(() => f.leases.inspect(owner.ownerLeaseId, 'session-b'), { code: 'SUBAPP_OWNER_MISMATCH' });
  assert.throws(() => f.leases.recover(owner.ownerLeaseId, 'session-b', randomUUID()), { code: 'SUBAPP_OWNER_MISMATCH' });
  assert.equal(f.leases.recover('unknown-owner', 'session-a', randomUUID()).errorCode, 'SUBAPP_OWNER_UNKNOWN');
  assert.equal(f.calls.length, 0);
});

test('expired inspection is read-only; explicit recovery waits for the old cleanup', async t => {
  const cleanup = deferred(), f = fixture(t, () => cleanup.promise), owner = f.leases.acquire('session-a');
  f.expire();
  assert.equal(f.leases.inspect(owner.ownerLeaseId, owner.sessionId).state, 'expired');
  assert.equal(f.calls.length, 0);
  const requestId = randomUUID();
  assert.equal(f.leases.recover(owner.ownerLeaseId, owner.sessionId, requestId).errorCode, 'SUBAPP_OWNER_RETIRING');
  assert.throws(() => f.leases.require(owner.ownerLeaseId, owner.sessionId), { code: 'SUBAPP_OWNER_EXPIRED' });
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  cleanup.resolve({ ok: true });
  await f.leases.release(owner.ownerLeaseId, owner.sessionId);
  const recovered = f.leases.recover(owner.ownerLeaseId, owner.sessionId, requestId);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.notResumed, true);
  assert.equal(recovered.deviceResourcesRestored, false);
  assert.notEqual(recovered.ownerLeaseId, owner.ownerLeaseId);
  assert.equal(recovered.recoveryReceipt.previousOwnerLeaseId, owner.ownerLeaseId);
  assert.equal(recovered.recoveryReceipt.domainOperationsReplayed, false);
});

test('lost recovery replies observe the same successor and reject a new nonce', async t => {
  const f = fixture(t), owner = f.leases.acquire('session-a'), requestId = randomUUID();
  await f.leases.release(owner.ownerLeaseId, owner.sessionId);
  const first = f.leases.recover(owner.ownerLeaseId, owner.sessionId, requestId);
  assert.equal(first.ok, true);
  const observed = f.leases.recover(owner.ownerLeaseId, owner.sessionId, requestId);
  assert.equal(observed.ownerLeaseId, first.ownerLeaseId);
  assert.equal(observed.reused, true);
  assert.deepEqual(observed.recoveryReceipt, first.recoveryReceipt);
  assert.equal(f.leases.recover(owner.ownerLeaseId, owner.sessionId, randomUUID()).errorCode, 'SUBAPP_OWNER_RECOVERY_REQUEST_MISMATCH');
  assert.equal(f.calls.length, 1);
});

test('old release and cancellation cannot revoke the recovered owner or another owner', async t => {
  const f = fixture(t), old = f.leases.acquire('session-a'), other = f.leases.acquire('session-b');
  await f.leases.release(old.ownerLeaseId, old.sessionId);
  const recovered = f.leases.recover(old.ownerLeaseId, old.sessionId, randomUUID());
  assert.equal(recovered.ok, true);
  await f.leases.release(old.ownerLeaseId, old.sessionId);
  assert.throws(() => f.leases.cancel(old.ownerLeaseId, old.sessionId, 'late-cancel'), { code: 'SUBAPP_OWNER_EXPIRED' });
  f.leases.require(recovered.ownerLeaseId, old.sessionId, 'future-request');
  f.leases.require(other.ownerLeaseId, other.sessionId, 'other-request');
  assert.equal(f.calls.length, 1);
});

test('unjoined cancelled requests remain counted until they actually finish', async t => {
  let f;
  f = fixture(t, async lease => ({ ok: (await f.requests.release(lease.ownerLeaseId)).length === 0 }));
  const owner = f.leases.acquire('session-a'), pending = f.requests.start(owner.ownerLeaseId, undefined, 'old-request');
  await f.leases.release(owner.ownerLeaseId, owner.sessionId);
  assert.equal(pending.signal.aborted, true);
  assert.equal(f.requests.pendingCount(owner.ownerLeaseId), 1);
  const requestId = randomUUID();
  assert.equal(f.leases.recover(owner.ownerLeaseId, owner.sessionId, requestId).errorCode, 'SUBAPP_OWNER_PENDING_REQUESTS');
  pending.finish();
  assert.equal(f.requests.pendingCount(owner.ownerLeaseId), 0);
  assert.equal(f.leases.recover(owner.ownerLeaseId, owner.sessionId, requestId).ok, true);
});

test('failed cleanup never becomes success after a second release sees no active lease', async t => {
  const f = fixture(t, async () => ({ ok: false, cleanupErrors: ['stop not confirmed'] }));
  const old = f.leases.acquire('session-a'), requestId = randomUUID();
  await f.leases.release(old.ownerLeaseId, old.sessionId);
  assert.equal(f.leases.recover(old.ownerLeaseId, old.sessionId, requestId).errorCode, 'SUBAPP_OWNER_CLEANUP_FAILED');
  await f.leases.release(old.ownerLeaseId, old.sessionId);
  assert.equal(f.leases.recover(old.ownerLeaseId, old.sessionId, requestId).errorCode, 'SUBAPP_OWNER_CLEANUP_FAILED');
  assert.equal(f.calls.length, 1);
});

test('an expired successor has an exact receipt, not another implicit incarnation', async t => {
  const f = fixture(t), old = f.leases.acquire('session-a'), requestId = randomUUID();
  await f.leases.release(old.ownerLeaseId, old.sessionId);
  const first = f.leases.recover(old.ownerLeaseId, old.sessionId, requestId);
  f.expire();
  const expired = f.leases.recover(old.ownerLeaseId, old.sessionId, requestId);
  assert.equal(expired.ok, false);
  assert.equal(expired.errorCode, 'SUBAPP_OWNER_RECOVERY_RECEIPT_EXPIRED');
  assert.equal(expired.ownerLeaseId, first.ownerLeaseId);
  assert.deepEqual(expired.recoveryReceipt, first.recoveryReceipt);
  assert.equal(f.calls.length, 1);
});

test('observing a renewed successor reports its current expiry with the same immutable identity', async t => {
  const f = fixture(t), old = f.leases.acquire('session-a'), requestId = randomUUID();
  await f.leases.release(old.ownerLeaseId, old.sessionId);
  const first = f.leases.recover(old.ownerLeaseId, old.sessionId, requestId);
  f.advance(40000); f.leases.renew(first.ownerLeaseId, first.sessionId); f.advance(50000);
  const observed = f.leases.recover(old.ownerLeaseId, old.sessionId, requestId);
  assert.equal(observed.ok, true);
  assert.ok(observed.expiresAt > 50000);
  assert.deepEqual(observed.recoveryReceipt, first.recoveryReceipt);
});
