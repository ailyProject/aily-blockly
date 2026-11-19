import assert from 'node:assert/strict'
import test from 'node:test'
import { taskThinking } from './task-thinking.mjs'
import { summarizeBuildInvocationAttempts } from './online-comparison.mjs'

const entry = (at, thinkingLevel) => ({ type: 'thinking_level_change', timestamp: new Date(at).toISOString(), thinkingLevel })
test('setup transitions do not change the submitted task selection', () => {
  const result = taskThinking([entry(1000, 'off'), entry(2000, 'low'), entry(3000, 'high')], 4000)
  assert.equal(result.complete, true)
  assert.deepEqual(result.levels, ['high'])
  assert.deepEqual(result.sessionLevels, ['off', 'low', 'high'])
})
test('an actual change during the task remains visible', () => {
  const result = taskThinking([entry(1000, 'high'), entry(5000, 'low')], 4000)
  assert.equal(result.complete, true)
  assert.deepEqual(result.levels, ['high', 'low'])
})
test('missing or malformed selection timestamps cannot prove the initial level', () => {
  assert.equal(taskThinking([entry(5000, 'high')], 4000).complete, false)
  assert.equal(taskThinking([{ type: 'thinking_level_change', thinkingLevel: 'high' }], 4000).complete, false)
})
test('a newly persisted session selection is checked at first provider preparation, not the earlier UI invocation', () => {
  const entries = [entry(3000, 'high')]
  assert.equal(taskThinking(entries, 1000).complete, false)
  assert.equal(taskThinking(entries, 4000).complete, true)
  assert.deepEqual(taskThinking(entries, 4000).levels, ['high'])
})
test('schema rejections stay counted but do not become admitted compiler starts', () => {
  const snapshot = { messages: [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'bad', name: 'project_build', arguments: { build_target_pid: 0, build_request_id: '' } },
      { type: 'toolCall', id: 'real', name: 'project_build', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'bad', isError: true, content: [{ type: 'text', text: 'Validation failed for tool "project_build":\n  - build_target_pid: must be >= 1' }] },
    { role: 'toolResult', toolCallId: 'real', content: [{ type: 'text', text: JSON.stringify({ buildReceipt: { version: 1, requestId: 'original' } }) }] }
  ] }
  const actual = summarizeBuildInvocationAttempts(snapshot)
  assert.equal(actual.startAttemptCount, 2)
  assert.equal(actual.preDispatchInputValidationCount, 1)
  assert.equal(actual.admittedStartAttemptCount, 1)
  assert.deepEqual(actual.confirmedRequestIds, ['original'])
  snapshot.messages[1].content[0].text = 'Build outcome unknown after a transport failure'
  assert.equal(summarizeBuildInvocationAttempts(snapshot).admittedStartAttemptCount, 2,
    'An unknown Host outcome must never be reclassified as pre-dispatch validation')
})
