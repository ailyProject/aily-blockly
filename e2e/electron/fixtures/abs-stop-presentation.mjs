import assert from 'node:assert/strict'

const interrupted = /^(?:用户暂停|使用者暫停|Paused by user|已停止|Stopped)$/iu
const interruptedTool = /^(?:已中断|已中斷|Interrupted)$/iu
const failedTool = /^(?:失败|失敗|Failed)$/iu

/** Terminal runtime safety is separate from its user-visible classification. */
export function assertUserStoppedAssistant(snapshot) {
  const message = snapshot.messages.findLast(value => value.role === 'assistant')
  assert.equal(message?.stopReason, 'aborted', 'A real user Stop must persist aborted, never a failed assistant message')
  const request = snapshot.entries?.findLast(entry => entry.type === 'custom' && entry.customType === 'aily.abort-request'
    && entry.data?.sessionId === snapshot.sessionId && entry.data.source === 'user' && entry.data.reason === 'user_stop')
  assert.ok(request, 'Cancellation display requires the actual persisted user-stop request')
  const entry = snapshot.entries.findLast(value => value.type === 'message' && value.message.role === 'assistant'
    && value.message.timestamp === message.timestamp)
  assert.ok(entry, 'The neutral terminal must identify the actual persisted assistant')
  assert.equal(entry.message.stopReason, 'aborted', 'UI or snapshot compatibility must not hide a new persisted terminal error')
  assert.equal(entry.message.errorMessage, message.errorMessage)
  // Assistant message timestamps can identify provider/request start. The raw
  // session append and its own timestamp identify terminal persistence.
  const abortPersistedAt = Date.parse(request.timestamp), persistedAt = Date.parse(entry.timestamp)
  assert.ok(Number.isFinite(abortPersistedAt) && Number.isFinite(persistedAt), 'User Stop and terminal require their actual persisted entry timestamps')
  assert.ok(Number.isFinite(request.data.requestedAt) && request.data.requestedAt <= abortPersistedAt
    && abortPersistedAt <= persistedAt, 'The aborted terminal must be persisted after the actual user Stop')
  assert.ok(snapshot.entries.indexOf(request) < snapshot.entries.indexOf(entry), 'The user Stop append must precede the aborted terminal append')
  const byId = new Map(snapshot.entries.map(value => [value.id, value])), visited = new Set()
  let ancestor = entry.parentId
  while (ancestor && ancestor !== request.id && !visited.has(ancestor)) { visited.add(ancestor); ancestor = byId.get(ancestor)?.parentId }
  assert.equal(ancestor, request.id, 'The aborted terminal must descend from this actual Stop on the same branch')
  const trace = snapshot.entries.findLast(value => value.type === 'custom' && value.customType === 'aily.trace'
    && value.data?.phase === 'run_settled' && value.data.sessionId === snapshot.sessionId)
  assert.ok(trace, 'The real stopped run must have a persisted run_settled trace')
  assert.equal(trace.data.status, 'aborted', 'Stop statistics must not classify user cancellation as an error')
  assert.ok(trace.data.startedAt <= request.data.requestedAt && trace.data.completedAt >= persistedAt)
  return { entryId: entry.id, timestamp: message.timestamp, stopReason: message.stopReason, errorMessage: message.errorMessage,
    timestampSemantics: 'provider-or-message-start', persistedAt, abortPersistedAt, stopEntryAncestorVerified: true,
    abortRequestEntryId: request.id, source: request.data.source, reason: request.data.reason,
    rawAssistantMessage: structuredClone(message), rawAssistantEntry: structuredClone(entry), rawAbortRequestEntry: structuredClone(request),
    traceEntryId: trace.id, trace: { runId: trace.data.runId, status: trace.data.status,
      startedAt: trace.data.startedAt, completedAt: trace.data.completedAt, error: trace.data.error } }
}

export function assertCancelledApplicationTool(tool) {
  assert.equal(tool?.isError, true, 'Retain the real tool result; projection alone changes its display')
  assert.equal(tool.result?.code, 'ABS_OPERATION_CANCELLED')
  assert.equal(tool.result.cancelled, true)
  assert.equal(tool.result.publication?.status, 'NOT_COMMITTED')
  if (Object.hasOwn(tool.result, 'commandDispatched')) assert.equal(tool.result.commandDispatched, false)
  return { toolCallId: tool.id, code: tool.result.code, cancelled: true, publication: tool.result.publication,
    commandDispatchedPresent: Object.hasOwn(tool.result, 'commandDispatched') }
}

/** Input is read from real DOM. Only the terminal assistant cancellation card
 * is required neutral; the deliberately injected native load failure stays red. */
export function assertUserStopTerminalUi(ui) {
  assert.ok(ui.interruptions.some(item => item.visible && interrupted.test(item.text.trim())), 'Show the localized user-paused status')
  assert.deepEqual(ui.terminalErrorCards, [], 'Do not render a red terminal request-failed cancellation card')
  assert.deepEqual(ui.abortErrorAlerts, [], 'Do not surface abort transport text as an alert')
  assert.equal(ui.terminalRetryButtons, 0, 'User Stop must not expose an automatic error retry action')
}

/** Self-contained for evaluation inside the real Chat frame. */
export function readUserStopTerminalUi() {
  const visible = node => !!(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
  const terminal = '.chat-part[data-part-type="error"]'
  return {
    interruptions: [...document.querySelectorAll('.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]')]
      .map(node => ({ text: node.textContent ?? '', visible: visible(node) })),
    terminalErrorCards: [...document.querySelectorAll(terminal + ' .x-aily-error-viewer[data-sev="error"]')].map(node => node.textContent),
    abortErrorAlerts: [...document.querySelectorAll('[role="alert"]')]
      .filter(node => /This operation was aborted|Request aborted \(user/i.test(node.textContent ?? '')).map(node => node.textContent),
    terminalRetryButtons: document.querySelectorAll(terminal + ' .x-aily-error-retry-button').length }
}

export function assertUserStoppedUi(ui, mode) {
  assertUserStopTerminalUi(ui)
  const applied = ui.toolCards.filter(item => /^(?:Abs Apply|abs_apply)$/iu.test(item.title.trim()))
  assert.equal(applied.length, 1)
  if (mode === 'recovery-owner') {
    assert.equal(applied[0].tone, 'neutral')
    assert.ok(interruptedTool.test(applied[0].status.trim()), 'The late ABS_OPERATION_CANCELLED tool must be interrupted')
    const reload = ui.toolCards.filter(item => /^(?:App Reload|app_reload)$/iu.test(item.title.trim()))
    assert.equal(reload.length, 1)
    assert.equal(reload[0].tone, 'error', 'Do not conceal the actual injected native load error')
    assert.ok(failedTool.test(reload[0].status.trim()))
  } else {
    assert.notEqual(applied[0].tone, 'error', 'A verified COMMITTED apply remains successful after stopping observation')
    assert.equal(applied[0].status, '')
  }
  return { terminalAssistantNeutral: true, cancellationToolInterrupted: mode === 'recovery-owner',
    realNativeFailureRetained: mode === 'recovery-owner', toolCards: ui.toolCards }
}
