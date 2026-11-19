import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapCleanupDecision } from './bootstrap-cleanup.mjs'

test('submitted task with unknown or stale observation never authorizes cleanup', () => {
  const state = { hostStarted: true, submissionAttempted: true,
    hostState: { lifecycleOwners: 0, hasRunning: false }, sessionObserved: true,
    session: { isIdle: true, isStreaming: false, messages: [{ role: 'assistant', stopReason: 'stop' }] } }
  assert.equal(bootstrapCleanupDecision(state).allowed, true)
  assert.equal(bootstrapCleanupDecision({ ...state, hostState: null }).allowed, false)
  assert.equal(bootstrapCleanupDecision({ ...state, sessionObserved: false }).allowed, false)
  assert.equal(bootstrapCleanupDecision({ ...state, session: undefined }).allowed, false)
  assert.equal(bootstrapCleanupDecision({ ...state, hostState: { ...state.hostState, buildRequestId: 'original', buildCompleted: false } }).allowed, false)
  assert.equal(bootstrapCleanupDecision({ ...state, hostState: { ...state.hostState, lifecycleOwners: 1 } }).allowed, false)
})
