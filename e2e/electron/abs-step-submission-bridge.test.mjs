import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createAbsStepSubmissionBridge } from '../fixtures/abs-step-submission-bridge.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')

test('localhost fixture accepts once, loses headers, and serves only exact read-only receipt/events', async () => {
  let models = 0
  const server = await createAbsStepSubmissionBridge({ interactionId: 'itx-local-proof', failAfterToolId: 'edit-once',
    nextTool: async ({ step }) => {
      models++
      return step === 0 ? { id: 'edit-once', name: 'edit', arguments: { path: 'fixture-only', edits: [] } } : undefined
    } })
  try {
    const create = await fetch(server.origin + '/api/v3/interactions', { method: 'POST', body: JSON.stringify({
      request: { request_context: { interaction_recovery: 'operation_stream_v1' } } }) })
    assert.equal(create.headers.get('x-aily-operation-id'), 'itx-local-proof:0')
    assert.match(await create.text(), /edit-once/)
    const raw = JSON.stringify({ stepIndex: 1, lease: 'isolated-step-lease-1', action: { kind: 'tool_results',
      payload: { results: [{ toolCallId: 'edit-once', result: 'actual tool result retained' }] } }, request: {} })
    const headers = { 'content-type': 'application/json', 'x-aily-step-submission-version': '1',
      'x-aily-step-submission-id': randomUUID(), 'x-aily-step-request-sha256': sha(raw) }
    await assert.rejects(fetch(server.origin + '/api/v3/interactions/itx-local-proof/steps', { method: 'POST', headers, body: raw }),
      /fetch failed/)
    const observation = { ...headers, 'x-aily-step-original-lease': 'isolated-step-lease-1' }
    const path = server.origin + '/api/v3/interactions/itx-local-proof/operations/1'
    const state = await fetch(path + '/state', { headers: observation })
    const body = await state.json()
    assert.deepEqual(body.stepSubmission, { version: 1, submissionId: headers['x-aily-step-submission-id'],
      requestSha256: sha(raw), originalLeaseSha256: sha('isolated-step-lease-1'), stepIndex: 1,
      operationId: 'itx-local-proof:1', accepted: true, interactionId: 'itx-local-proof' })
    const events = await fetch(path + '/events?after=0', { headers: observation })
    assert.equal(events.headers.get('x-aily-operation-id'), 'itx-local-proof:1')
    assert.equal(events.headers.get('x-aily-operation-step'), '1')
    const frames = (await events.text()).trim().split('\n\n').map(line => JSON.parse(line.slice(6)))
    assert.deepEqual(frames.map(frame => frame.seq), [1, 2, 3, 4])
    assert.equal(models, 2)
    const proof = server.snapshot()
    assert.deepEqual(proof.failures, [])
    assert.equal(proof.operations[1].providerInvocations, 1)
    assert.equal(proof.operations[1].postCount, 1)
    assert.equal(proof.operations[1].headersLost, true)
    assert.equal(proof.operations[1].stateReads, 1)
    assert.equal(proof.operations[1].eventReads, 1)
    const denied = await fetch(path + '/events?after=0', { headers: { ...observation, 'x-aily-step-original-lease': 'foreign-owner' } })
    assert.equal(denied.status, 409)
    assert.equal(models, 2, 'A foreign observation cannot dispatch another provider')
    assert.equal(server.snapshot().operations[1].postCount, 1)
  } finally { await server.close() }
})
