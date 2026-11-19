import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createAbsStopModel } from '../../fixtures/abs-stop-model.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const post = (origin, route, value, extra = {}) => {
  const body = JSON.stringify(value)
  return fetch(origin + route, { method: 'POST', body, headers: { 'content-type': 'application/json',
    ...(route === '/api/v3/interactions' ? { 'x-aily-create-request-sha256': sha(body) } : {
      'x-aily-step-request-sha256': sha(body), 'x-aily-step-submission-version': '1', 'x-aily-step-submission-id': '11111111-1111-4111-8111-111111111111' }), ...extra } })
}
const create = id => ({ threadId: 'local-thread', idempotencyKey: id,
  request: { request_context: { interaction_recovery: 'operation_stream_v1' } } })

test('local stop model binds cancellation to its original create and permits a separate next turn', async () => {
  const model = await createAbsStopModel({ nextTool: async ({ turn }) => ({ id: `apply-${turn}`, name: 'tool_invoke', arguments: { name: 'abs_apply', arguments: { project: 'owned-project' } } }) })
  try {
    assert.equal((await post(model.origin, '/api/v3/interactions', create('first'))).status, 200)
    assert.equal((await post(model.origin, '/api/v3/interactions/interrupt', { threadId: 'local-thread', idempotencyKey: 'first' })).status, 200)
    assert.equal((await post(model.origin, '/api/v3/interactions', create('second'))).status, 200)
    const snapshot = model.snapshot()
    assert.equal(snapshot.createCount, 2); assert.equal(snapshot.interactions[0].interruptCount, 1)
    assert.equal(snapshot.interactions[1].interrupted, false); assert.deepEqual(snapshot.failures, [])
    assert.equal(snapshot.requests[1].originalIdentityVerified, true)
    assert.equal(JSON.stringify(snapshot).includes('idempotencyKey'), false)
  } finally { await model.close() }
})

test('local stop model rejects foreign cancellation and continuation of a stopped interaction', async () => {
  const model = await createAbsStopModel({ nextTool: async () => ({ id: 'apply-1', name: 'tool_invoke', arguments: { name: 'abs_apply', arguments: { project: 'owned-project' } } }) })
  try {
    await post(model.origin, '/api/v3/interactions', create('first'))
    assert.equal((await post(model.origin, '/api/v3/interactions/interrupt', { threadId: 'local-thread', idempotencyKey: 'other' })).status, 409)
    await post(model.origin, '/api/v3/interactions/interrupt', { threadId: 'local-thread', idempotencyKey: 'first' })
    const id = model.snapshot().interactions[0].id
    assert.equal((await post(model.origin, `/api/v3/interactions/${id}/steps`, { stepIndex: 1, lease: `${id}-lease-1`, action: { kind: 'tool_results', payload: { results: [] } } })).status, 409)
    assert.equal(model.snapshot().failures.length, 2)
  } finally { await model.close() }
})

test('local stop model requires the previous exact tool result for each next step', async () => {
  const model = await createAbsStopModel({ nextTool: async ({ step, previousResult }) => {
    if (!step) return { id: 'read-1', name: 'read', arguments: { path: 'owned-project/project.abs' } }
    assert.equal(previousResult.toolCallId, 'read-1'); return undefined
  } })
  try {
    await post(model.origin, '/api/v3/interactions', create('first'))
    const id = model.snapshot().interactions[0].id
    const value = { stepIndex: 1, lease: `${id}-lease-1`, action: { kind: 'tool_results', payload: { results: [{ toolCallId: 'read-1', result: { content: [] } }] } } }
    assert.equal((await post(model.origin, `/api/v3/interactions/${id}/steps`, value)).status, 200)
    assert.equal(model.snapshot().interactions[0].completed, true); assert.deepEqual(model.snapshot().failures, [])
  } finally { await model.close() }
})

test('local stop model does not disguise an original create repost as another user turn', async () => {
  const model = await createAbsStopModel({ nextTool: async () => undefined })
  try {
    assert.equal((await post(model.origin, '/api/v3/interactions', create('same-original'))).status, 200)
    assert.equal((await post(model.origin, '/api/v3/interactions', create('same-original'))).status, 409)
    assert.equal(model.snapshot().createCount, 1); assert.equal(model.snapshot().failures.length, 1)
  } finally { await model.close() }
})
