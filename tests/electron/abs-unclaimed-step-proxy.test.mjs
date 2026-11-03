import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { createAbsStepSubmissionBridge } from '../../e2e/fixtures/abs-step-submission-bridge.mjs'
import { createAbsUnclaimedStepProxy } from '../../e2e/fixtures/abs-unclaimed-step-proxy.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')

for (const tamper of [false, true]) test(`unclaimed request binding and accepted ACK loss, tamper=${tamper}`, async () => {
  const interactionId = 'itx_proxy_' + randomUUID().replaceAll('-', '')
  const bridge = await createAbsStepSubmissionBridge({ interactionId, failAfterToolId: 'edited-once',
    nextTool: async ({ step }) => step === 0 ? { id: 'edited-once', name: 'edit', arguments: {} } : undefined })
  const proxy = await createAbsUnclaimedStepProxy({ upstreamOrigin: bridge.origin, failAfterToolId: 'edited-once' })
  try {
    const created = await fetch(proxy.origin + '/api/v3/interactions', { method: 'POST', body: JSON.stringify({
      request: { request_context: { interaction_recovery: 'operation_stream_v1' } } }) })
    await created.text()
    const path = `/api/v3/interactions/${interactionId}`
    const body = JSON.stringify({ stepIndex: 1, lease: 'isolated-step-lease-1', action: { kind: 'tool_results',
      payload: { results: [{ toolCallId: 'edited-once', isError: false, content: [{ type: 'text', text: 'committed edit' }] }] } } })
    const headers = { 'content-type': 'application/json', 'x-aily-step-submission-id': randomUUID(),
      'x-aily-step-submission-version': '1', 'x-aily-step-request-sha256': sha(body), 'x-aily-step-recovery-version': '1' }
    await assert.rejects(fetch(proxy.origin + path + '/steps', { method: 'POST', headers, body }))
    const observationHeaders = { ...headers, 'x-aily-step-original-lease': 'isolated-step-lease-1' }
    const state = await (await fetch(proxy.origin + path + '/operations/1/state', { headers: observationHeaders })).json()
    assert.equal(state.stepSubmissionRecovery.disposition, 'not_claimed')
    const retriedBody = tamper ? body.replace('committed edit', 'different result') : body
    const retry = fetch(proxy.origin + path + '/steps', { method: 'POST', body: retriedBody, headers: {
      ...headers, 'x-aily-step-request-sha256': sha(retriedBody),
      'x-aily-step-retry-state-sha256': state.stepSubmissionRecovery.canonicalStateSha256 } })
    if (tamper) {
      assert.equal((await retry).status, 409)
      assert.equal(proxy.snapshot().forwardedTargetPosts, 0)
      assert.equal(bridge.snapshot().operations.length, 1)
      assert.equal(proxy.snapshot().failures.length, 1)
    } else {
      await assert.rejects(retry)
      const accepted = await (await fetch(proxy.origin + path + '/operations/1/state', { headers: observationHeaders })).json()
      assert.equal(accepted.stepSubmission.accepted, true)
      const events = await (await fetch(proxy.origin + path + '/operations/1/events?after=0', { headers: observationHeaders })).text()
      assert.match(events, /turn_end/)
      assert.equal(proxy.snapshot().retryPosts, 1)
      assert.equal(proxy.snapshot().forwardedTargetPosts, 1)
      assert.deepEqual(proxy.snapshot().failures, [])
      const operation = bridge.snapshot().operations.find(value => value.step === 1)
      assert.equal(operation.providerInvocations, 1); assert.equal(operation.postCount, 1)
      assert.equal(operation.stateReads, 1); assert.equal(operation.eventReads, 1)
      assert.equal(bridge.snapshot().interruptCount, 0)
    }
  } finally { await proxy.close(); await bridge.close() }
})
