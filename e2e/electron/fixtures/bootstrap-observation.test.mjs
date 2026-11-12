import assert from 'node:assert/strict'
import test from 'node:test'
import { readBootstrapObservation, createBootstrapReadOnlyObserver } from './bootstrap-observation.mjs'

test('a readonly observer timeout retries the same original session while real service failures still reject', async () => {
  const ids = [], failures = []; let attempt = 0
  const value = await readBootstrapObservation(async () => {
    ids.push('original-session')
    if (attempt++ === 0) throw Object.assign(new Error('observer request deadline'), { name: 'TimeoutError' })
    return { sessionId: 'original-session', isIdle: false }
  }, { deadline: Date.now() + 1000, onTimeout: item => failures.push(item) })
  assert.deepEqual(ids, ['original-session', 'original-session']); assert.equal(failures.length, 1)
  assert.equal(value.sessionId, 'original-session'); assert.equal(value.isIdle, false)
  let rejectedCalls = 0
  await assert.rejects(readBootstrapObservation(async () => { rejectedCalls++; throw new Error('actual service rejected the read') },
    { deadline: Date.now() + 1000 }), /actual service rejected/)
  assert.equal(rejectedCalls, 1)
})

test('only temporary exact-session reopen replies retry, preserving structured failures and refusing other identities', async () => {
  const id = 'already-observed-original', requestIds = [], failures = []
  const success = { ok: true, method: 'session.read', result: { session: { sessionId: id, isIdle: false } } }
  const replies = [
    { status: 200, body: { ok: false, error: { code: 'SESSION_NOT_OPEN', message: 'Session is not open: ' + id } } },
    { status: 500, body: { ok: false, error: 'Session ' + id + ' is closed' } },
    { status: 200, body: success },
  ]
  const observer = createBootstrapReadOnlyObserver('http://127.0.0.1:12345/?token=test-only', {
    knownSessionIds: [id], onFailure: value => failures.push(value), fetchImpl: async (_url, options) => {
      requestIds.push(JSON.parse(options.body).sessionId); const next = replies.shift()
      return new Response(JSON.stringify(next.body), { status: next.status })
    } })
  const result = await readBootstrapObservation(() => observer('session.read', { sessionId: id }), { deadline: Date.now() + 2000 })
  assert.equal(result.session.sessionId, id); assert.equal(result.session.isIdle, false)
  assert.deepEqual(requestIds, [id, id, id]); assert.deepEqual(failures.map(value => value.status), [200, 500])
  for (const [knownSessionIds, body] of [
    [[], { ok: false, error: { code: 'SESSION_NOT_OPEN', message: 'Session is not open: ' + id } }],
    [[id], { ok: false, error: { code: 'SESSION_NOT_OPEN', message: 'Session is not open: different-id' } }],
    [[id], { ok: false, error: { code: 'INVALID_REQUEST', message: 'Session is not open: ' + id } }],
  ]) {
    let calls = 0
    const rejected = createBootstrapReadOnlyObserver('http://127.0.0.1:12345/?token=test-only', { knownSessionIds,
      fetchImpl: async () => { calls++; return new Response(JSON.stringify(body), { status: 200 }) } })
    await assert.rejects(readBootstrapObservation(() => rejected('session.read', { sessionId: id }), { deadline: Date.now() + 500 }))
    assert.equal(calls, 1)
  }
})
