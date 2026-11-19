import assert from 'node:assert/strict'
import test from 'node:test'
import { createAbsStepSubmissionBridge } from '../../fixtures/abs-step-submission-bridge.mjs'

test('controlled lifecycle provider accepts only its original interaction interruption identity', async () => {
  const bridge = await createAbsStepSubmissionBridge({ interactionId: 'bootstrap_interrupt_unit', allowInterrupt: true,
    async nextTool() { return null } })
  try {
    const identity = { threadId: 'test-owned-thread', idempotencyKey: 'test-owned-original-create' }
    const created = await fetch(bridge.origin + '/api/v3/interactions', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...identity,
        request: { request_context: { interaction_recovery: 'operation_stream_v1' } } }) })
    assert.equal(created.status, 200); await created.text()
    const interrupted = await fetch(bridge.origin + '/api/v3/interactions/interrupt', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(identity) })
    assert.equal(interrupted.status, 200); assert.deepEqual(await interrupted.json(), { status: 'interrupted' })
    assert.equal(bridge.snapshot().createCount, 1); assert.equal(bridge.snapshot().interruptCount, 1)
    assert.deepEqual(bridge.snapshot().failures, [])
    const wrong = await fetch(bridge.origin + '/api/v3/interactions/interrupt', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...identity, idempotencyKey: 'other-create' }) })
    assert.equal(wrong.status, 409); await wrong.text()
    assert.equal(bridge.snapshot().failures.length, 1)
  } finally { await bridge.close() }
})
