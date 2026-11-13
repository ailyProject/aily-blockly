import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyCustomerApplyObservationTrace } from './customer-apply-observation-trace.mjs'

const requestId = 'owned-request'
const trace = () => [
  { operation: 'abs_apply', requestId, dropped: true },
  { operation: 'abs_recovery', action: 'observe_apply', requestId, dropped: true },
  { operation: 'abs_recovery', action: 'observe_apply', requestId, dropped: false },
  { operation: 'abs_recovery', action: 'read_candidate', recordHash: 'record-a', dropped: false }
]

test('accepts only a real post-release backup read and the one original native application', () => {
  const result = verifyCustomerApplyObservationTrace(trace(), { requestId, backupRecordHash: 'record-a' })
  assert.equal(result.originalApplyDispatches, 1)
  assert.equal(result.firstObservationAfterCacheLoss, 2)
  assert.equal(result.candidateReadAfterCacheLoss, 3)
  assert.equal(result.exactRecordHashCaptured, true)
})

test('an earlier preparation backup read does not prove restoration after cache loss', () => {
  const commands = trace()
  commands.splice(3, 1)
  commands.unshift({ operation: 'abs_recovery', action: 'read_candidate', recordHash: 'record-a', dropped: false })
  assert.throws(() => verifyCustomerApplyObservationTrace(commands, { requestId }), /after observing/)
})

test('rejects the wrong original request, repeated application and wrong retained record', () => {
  assert.throws(() => verifyCustomerApplyObservationTrace(trace(), { requestId: 'other' }))
  assert.throws(() => verifyCustomerApplyObservationTrace([...trace(), trace()[0]], { requestId }), /never be dispatched again/)
  assert.throws(() => verifyCustomerApplyObservationTrace(trace(), { requestId, backupRecordHash: 'other' }), /exact retained/)
})

test('old traces can prove order without claiming they captured the record hash', () => {
  const commands = trace()
  delete commands[3].recordHash
  const result = verifyCustomerApplyObservationTrace(commands, { requestId })
  assert.equal(result.exactRecordHashCaptured, false)
})
