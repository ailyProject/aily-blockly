import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createAbsTerminalExpiryBridge } from '../../e2e/fixtures/abs-terminal-expiry-bridge.mjs'
import { createCombinedOperationFaultProxy } from '../../e2e/fixtures/combined-operation-fault-proxy.mjs'

test('one original interaction survives accepted-step ACK loss and expired final events without another POST', { timeout: 15000 }, async () => {
  const interactionId = 'itx_combined_' + randomUUID().replaceAll('-', '')
  const upstream = await createAbsTerminalExpiryBridge({ interactionId, mode: 'available', nextTool: async ({ step }) => step < 2
    ? { id: step === 0 ? 'agent-edit-once' : 'read-after-ack', name: step === 0 ? 'edit' : 'read', arguments: {} } : undefined })
  const proxy = await createCombinedOperationFaultProxy({ upstreamOrigin: upstream.origin, failAfterToolId: 'agent-edit-once' })
  const sha = text => createHash('sha256').update(text).digest('hex')
  const base = `${proxy.origin}/api/v3/interactions/${interactionId}`
  const body = step => JSON.stringify({ stepIndex: step, lease: `isolated-terminal-lease-${step}`, action: { kind: 'tool_results',
    payload: { results: [{ toolCallId: step === 1 ? 'agent-edit-once' : 'read-after-ack', isError: false, result: { content: [] } }] } } })
  const headers = raw => ({ 'content-type': 'application/json', 'x-aily-step-submission-version': '1',
    'x-aily-step-submission-id': randomUUID(), 'x-aily-step-request-sha256': sha(raw) })
  try {
    const create = await fetch(proxy.origin + '/api/v3/interactions', { method: 'POST',
      body: JSON.stringify({ request: { request_context: { interaction_recovery: 'operation_stream_v1' } } }) })
    assert.equal(create.status, 200); assert.match(await create.text(), /agent-edit-once/)
    const submitted = body(1), requestHeaders = headers(submitted)
    await assert.rejects(fetch(base + '/steps', { method: 'POST', headers: requestHeaders, body: submitted }))
    const observationHeaders = { ...requestHeaders, 'x-aily-step-original-lease': 'isolated-terminal-lease-1' }
    const state = await fetch(base + '/operations/1/state', { headers: observationHeaders })
    assert.equal(state.status, 200)
    const observed = await state.json()
    assert.equal(observed.stepSubmission.accepted, true)
    assert.equal(observed.stepSubmission.requestSha256, sha(submitted))
    assert.equal(observed.pendingKind, 'tool_results')
    const replay = await fetch(base + '/operations/1/events?after=0', { headers: observationHeaders })
    assert.equal(replay.status, 200); assert.match(await replay.text(), /read-after-ack/)
    const finalBody = body(2)
    const final = await fetch(base + '/steps', { method: 'POST', headers: headers(finalBody), body: finalBody })
    assert.equal(final.status, 200)
    const partial = await final.text()
    assert.match(partial, /markdown_delta/); assert.doesNotMatch(partial, /turn_end/)
    assert.equal((await fetch(base + '/operations/2/events?after=3')).status, 410)
    const terminal = await (await fetch(base + '/operations/2/state')).json()
    assert.equal(terminal.executionTerminal.outputState, 'available')
    const result = await (await fetch(base + '/operations/2/result')).json()
    assert.equal(result.text, upstream.finalText)
    const proof = proxy.snapshot()
    assert.deepEqual(proof.failures, []); assert.equal(proof.droppedResponses, 1)
    assert.equal(proof.duplicatePosts, 0)
    assert.equal(proof.operation.stateReads, 1); assert.equal(proof.operation.eventReads, 1)
    const original = upstream.snapshot()
    assert.deepEqual(original.failures, []); assert.equal(original.createCount, 1)
    for (const operation of original.operations) { assert.equal(operation.postCount, 1); assert.equal(operation.providerInvocations, 1) }
  } finally { await proxy.close(); await upstream.close() }
})
