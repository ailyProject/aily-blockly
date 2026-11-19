import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCancelledApplicationTool, assertUserStoppedAssistant, assertUserStoppedUi } from './abs-stop-presentation.mjs'

const snapshot = reason => ({ sessionId: 'owned-session', messages: [{ role: 'assistant', stopReason: reason,
  errorMessage: 'Request aborted (user: user_stop)', timestamp: 200 }], entries: [
  { type: 'custom', id: 'stop-id', parentId: 'previous', timestamp: new Date(101).toISOString(), customType: 'aily.abort-request', data: { sessionId: 'owned-session', source: 'user', reason: 'user_stop', requestedAt: 100 } },
  { type: 'message', id: 'assistant-id', parentId: 'stop-id', timestamp: new Date(201).toISOString(), message: { role: 'assistant', stopReason: reason, errorMessage: 'Request aborted (user: user_stop)', timestamp: 200 } },
  { type: 'custom', id: 'trace-id', parentId: 'assistant-id', timestamp: new Date(251).toISOString(), customType: 'aily.trace', data: { phase: 'run_settled', runId: 'run-id', sessionId: 'owned-session', status: reason, startedAt: 50, completedAt: 250 } } ] })
const ui = () => ({ interruptions: [{ text: '用户暂停', visible: true }], terminalErrorCards: [], abortErrorAlerts: [], terminalRetryButtons: 0,
  toolCards: [{ title: 'Abs Apply', status: '已中断', tone: 'neutral' }, { title: 'App Reload', status: '失败', tone: 'error' }] })

test('stop presentation binds neutral status to the actual aborted assistant and user-stop entry', () => {
  const input = snapshot('aborted'), original = structuredClone(input)
  assert.equal(assertUserStoppedAssistant(input).entryId, 'assistant-id'); assert.deepEqual(input, original)
})

test('provider start before Stop is valid when the real aborted terminal persists afterward', () => {
  const input = snapshot('aborted'); input.messages[0].timestamp = 80; input.entries[1].message.timestamp = 80
  const result = assertUserStoppedAssistant(input)
  assert.equal(result.timestamp, 80); assert.equal(result.persistedAt, 201); assert.equal(result.stopEntryAncestorVerified, true)
})

test('a terminal truly persisted before Stop, on another branch, or without entry timestamps cannot qualify', () => {
  for (const mutate of [value => { value.entries[1].timestamp = new Date(90).toISOString() },
    value => { [value.entries[0], value.entries[1]] = [value.entries[1], value.entries[0]] },
    value => { value.entries[1].parentId = 'another-branch' },
    value => { delete value.entries[1].timestamp },
    value => { delete value.entries[0].timestamp }]) {
    const input = snapshot('aborted'); mutate(input); assert.throws(() => assertUserStoppedAssistant(input))
  }
})
test('the former This operation was aborted/error outcome cannot qualify as a normal stop', () => {
  const input = snapshot('error'); input.messages[0].errorMessage = 'This operation was aborted'
  assert.throws(() => assertUserStoppedAssistant(input), /must persist aborted/)
})
test('an unrelated abort without a matching user-stop request does not qualify', () => {
  const input = snapshot('aborted'); input.entries[0].data.source = 'transport'
  assert.throws(() => assertUserStoppedAssistant(input), /actual persisted user-stop/)
})
test('UI/snapshot compatibility cannot mask a new raw persisted error as aborted', () => {
  const input = snapshot('aborted'); input.entries[1].message.stopReason = 'error'
  input.entries[1].message.errorMessage = 'This operation was aborted'
  assert.throws(() => assertUserStoppedAssistant(input), /persisted terminal error/)
})
test('a missing trace or an error trace cannot pass user-stop statistics', () => {
  const input = snapshot('aborted'); input.entries[2].data.status = 'error'
  assert.throws(() => assertUserStoppedAssistant(input), /statistics/)
  input.entries.pop(); assert.throws(() => assertUserStoppedAssistant(input), /run_settled trace/)
})
test('neutral cancellation retains the genuine earlier native tool failure', () => {
  assert.equal(assertUserStoppedUi(ui(), 'recovery-owner').realNativeFailureRetained, true)
  const committed = ui(); committed.toolCards = [{ title: 'Abs Apply', status: '', tone: '' }]
  assert.equal(assertUserStoppedUi(committed, 'apply-chat').terminalAssistantNeutral, true)
})
test('a red cancellation card or abort alert must fail despite a neutral marker', () => {
  const input = ui(); input.terminalErrorCards.push({ title: '请求失败', text: 'This operation was aborted' })
  assert.throws(() => assertUserStoppedUi(input, 'recovery-owner'), /red terminal/)
  input.terminalErrorCards = []; input.abortErrorAlerts.push('This operation was aborted')
  assert.throws(() => assertUserStoppedUi(input, 'recovery-owner'), /abort transport/)
})
test('the cancelled tool itself must be interrupted, while a real error cannot be hidden', () => {
  const input = ui(); input.toolCards[0].tone = 'error'
  assert.throws(() => assertUserStoppedUi(input, 'recovery-owner'))
  input.toolCards[0].tone = 'neutral'; input.toolCards[1].tone = 'neutral'
  assert.throws(() => assertUserStoppedUi(input, 'recovery-owner'), /native load error/)
})
test('cancelled application qualification preserves structured data and refuses committed/other failures', () => {
  const tool = { id: 'apply-stopped', isError: true, result: { code: 'ABS_OPERATION_CANCELLED', cancelled: true,
    publication: { status: 'NOT_COMMITTED' }, candidateArtifact: { path: 'owned-backup' } } }
  const before = structuredClone(tool)
  assert.equal(assertCancelledApplicationTool(tool).code, 'ABS_OPERATION_CANCELLED'); assert.deepEqual(tool, before)
  tool.result.publication.status = 'COMMITTED'; assert.throws(() => assertCancelledApplicationTool(tool))
  tool.result.publication.status = 'NOT_COMMITTED'; tool.result.code = 'ABS_BASELINE_STALE'
  assert.throws(() => assertCancelledApplicationTool(tool))
})
