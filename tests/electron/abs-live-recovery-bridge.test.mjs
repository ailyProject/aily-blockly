import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'

import { createAbsStepSubmissionBridge } from '../../e2e/fixtures/abs-step-submission-bridge.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const parseFrames = text => [...text.matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]))

test('live recovery bridge keeps one operation across lost ACK, live thinking and a second disconnect', async () => {
  const interactionId = 'itx_live_fixture_' + randomUUID().replaceAll('-', '')
  const bridge = await createAbsStepSubmissionBridge({ interactionId, failAfterToolId: 'edit-once',
    liveRecovery: { durationMs: 500 }, finalText: 'Fixture completed without executing any real tool.',
    nextTool: async ({ step }) => step === 0 ? { id: 'edit-once', name: 'edit', arguments: {} } : undefined })
  try {
    const original = await fetch(bridge.origin + '/api/v3/interactions', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: { request_context: { interaction_recovery: 'operation_stream_v1' } } }) })
    await original.text()
    const raw = JSON.stringify({ stepIndex: 1, lease: 'isolated-step-lease-1', action: { kind: 'tool_results',
      payload: { results: [{ toolCallId: 'edit-once', isError: false, result: { content: [] } }] } } })
    const headers = { 'content-type': 'application/json', 'x-aily-step-submission-version': '1',
      'x-aily-step-submission-id': randomUUID(), 'x-aily-step-request-sha256': sha(raw) }
    await assert.rejects(fetch(bridge.origin + `/api/v3/interactions/${interactionId}/steps`, {
      method: 'POST', headers, body: raw
    }))
    const base = bridge.origin + `/api/v3/interactions/${interactionId}/operations/1`
    const observationHeaders = { ...headers, 'x-aily-step-original-lease': 'isolated-step-lease-1' }
    const state = await (await fetch(base + '/state', { headers: observationHeaders })).json()
    assert.equal(state.status, 'running')
    assert.equal(state.lastSequence, 1, 'Thinking is not fabricated in advance as completed replay')
    const first = await fetch(base + '/events?after=0', { headers: observationHeaders })
    let wire = '', disconnected = false
    try {
      for await (const chunk of first.body) wire += new TextDecoder().decode(chunk)
    } catch { disconnected = true }
    assert.equal(disconnected, true)
    const frames = parseFrames(wire)
    assert.ok(frames.some(frame => frame.type === 'thinking_delta'))
    const after = frames.at(-1).seq
    const secondState = await (await fetch(base + '/state')).json()
    assert.equal(secondState.status, 'running')
    assert.ok(secondState.lastSequence >= after)
    const resumed = await fetch(base + `/events?after=${after}`)
    const tail = parseFrames(await resumed.text())
    assert.ok(tail.every(frame => frame.seq > after))
    assert.ok(tail.some(frame => frame.type === 'thinking_delta' && frame.seq > secondState.lastSequence))
    assert.equal(tail.at(-1).type, 'turn_end')
    const snapshot = bridge.snapshot(), operation = snapshot.operations.find(value => value.headersLost)
    assert.deepEqual(snapshot.failures, [])
    assert.equal(snapshot.createCount, 1)
    assert.equal(snapshot.interruptCount, 0)
    assert.equal(operation.postCount, 1)
    assert.equal(operation.providerInvocations, 1)
    assert.equal(operation.stateReads, 2)
    assert.equal(operation.eventReads, 2)
    assert.ok(operation.liveDurationMs >= 500)
    assert.equal(operation.earlyClientDisconnect, undefined)
    assert.equal(operation.secondResumeAfter, after)
  } finally { await bridge.close() }
})
