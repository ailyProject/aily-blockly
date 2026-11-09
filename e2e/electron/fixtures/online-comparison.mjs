import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { taskThinking } from './task-thinking.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
async function fileHash(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const textBytes = message => Buffer.byteLength((message?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n'))
const elapsed = (start, end) => Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null
const modelPost = item => item.method === 'POST' && /^\/api\/v3\/interactions(?:\/[^/]+\/steps)?$/.test(item.path)
const sumBytes = (items, key) => items.every(item => Number.isSafeInteger(item[key]))
  ? items.reduce((sum, item) => sum + item[key], 0) : null

/** Observe Todo facts from the real session and actual tool results. Neither
 * business success nor a fluent final answer can complete a task here. */
export function summarizeTodoProgress(snapshot) {
  const messages = snapshot?.messages ?? [], seenIds = new Set(), calls = []
  let latestToolTasks
  const taskState = tasks => tasks.map(task => ({ id: task.id, status: task.status })).sort((a, b) => a.id - b.id)
  for (const message of messages.filter(item => item.role === 'assistant')) {
    for (const call of (message.content ?? []).filter(item => item.type === 'toolCall')) {
      const name = call.name === 'tool_invoke' ? call.arguments?.name : call.name
      if (name !== 'todo') continue
      const input = call.name === 'tool_invoke' ? call.arguments?.arguments : call.arguments
      const result = messages.find(item => item.role === 'toolResult' && item.toolCallId === call.id)
      const details = result?.details
      if (result && result.isError !== true && !details?.error && Array.isArray(details?.tasks)) {
        latestToolTasks = taskState(details.tasks)
        for (const task of details.tasks) seenIds.add(task.id)
      }
      calls.push({ toolCallId: call.id, action: details?.action ?? input?.action ?? null,
        argumentBytes: Buffer.byteLength(JSON.stringify(input ?? {})), resultTextBytes: result ? textBytes(result) : null,
        resultIsError: result?.isError === true || !!details?.error, taskArgumentCount: input?.tasks?.length ?? 0,
        updates: Array.isArray(input?.updates) ? input.updates.map(item => ({ id: item.id, status: item.status }))
          : input?.id !== undefined ? [{ id: input.id, status: input.status ?? null }] : [],
        resultingTasks: Array.isArray(details?.tasks) ? taskState(details.tasks) : null })
    }
  }
  const available = Array.isArray(snapshot?.todos), finalTasks = available ? taskState(snapshot.todos) : null
  for (const task of finalTasks ?? []) seenIds.add(task.id)
  const valid = available && finalTasks.every(task => Number.isSafeInteger(task.id)
    && ['pending', 'in_progress', 'completed', 'deleted'].includes(task.status))
    && new Set(finalTasks.map(task => task.id)).size === finalTasks.length
  const missingTaskIds = available ? [...seenIds].filter(id => !finalTasks.some(task => task.id === id)) : null
  const pendingIds = finalTasks?.filter(task => task.status === 'pending').map(task => task.id) ?? null
  const inProgressIds = finalTasks?.filter(task => task.status === 'in_progress').map(task => task.id) ?? null
  const deletedIds = finalTasks?.filter(task => task.status === 'deleted').map(task => task.id) ?? null
  const completedCount = finalTasks?.filter(task => task.status === 'completed').length ?? null
  return { available, callCount: calls.length, calls, createdTaskCount: seenIds.size, finalTasks,
    pendingIds, inProgressIds, deletedIds, missingTaskIds, completedCount,
    finalStatusConsistent: valid ? missingTaskIds.length === 0 && finalTasks.every(task => task.status === 'completed') : null,
    toolProjectionConsistent: available ? latestToolTasks ? JSON.stringify(latestToolTasks) === JSON.stringify(finalTasks)
      : calls.length === 0 && finalTasks.length === 0 : null,
    interpretation: 'No Todo is required. If tasks were created, this successful isolated task must leave all observed tasks completed; deleted/cleared tasks are reported, never silently treated as completion.' }
}

/** Actual compiler/host-reported log durations, not inferred process clocks. */
export function summarizeCompilerReportedTimes(source) {
  const reports = []
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    const compiler = /^\[INFO\] (Preprocess|Build|Total) time: ([0-9]+(?:\.[0-9]+)?)s\s*$/.exec(line)
    const host = /^Build finished:.*\(耗时: ([0-9]+(?:\.[0-9]+)?)s\)\s*$/.exec(line)
    if (compiler) reports.push({ source: 'actual-compiler-log', phase: compiler[1].toLowerCase(), milliseconds: Number(compiler[2]) * 1000, line: index + 1 })
    else if (host) reports.push({ source: 'actual-host-build-log', phase: 'host-build-envelope', milliseconds: Number(host[1]) * 1000, line: index + 1 })
  }
  return { available: reports.length > 0, reports, pureCompilerWallClockMs: null,
    interpretation: 'Reported durations retain their original stage boundaries. Provider/tool clocks and the host build envelope are separate; missing native process clocks stay unknown.' }
}

/** Stored calls are after provider decoding, not HTTP wire names. Attempts
 * are not proof of native compilation; retain rejected aliases separately. */
export function summarizeBuildInvocationAttempts(snapshot) {
  const messages = snapshot?.messages ?? []
  const attempts = messages.filter(item => item.role === 'assistant').flatMap(item => item.content ?? [])
    .filter(call => call.type === 'toolCall' && (call.name === 'project_build'
      || call.name === 'tool_invoke' && call.arguments?.name === 'project_build')).map(call => {
      const args = call.name === 'tool_invoke' ? call.arguments?.arguments : call.arguments
      const message = messages.find(item => item.role === 'toolResult' && item.toolCallId === call.id)
      const text = (message?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
      let value = message?.details?.result
      if (!value) { try { value = JSON.parse(text) } catch { /* Preserve coded text errors separately. */ } }
      const code = value?.code ?? /^\[tool_error code=([a-z_]+)\]/.exec(text)?.[1] ?? null
      const receipt = value?.buildReceipt ?? null
      return { toolCallId: call.id, storedToolName: call.name, storedArguments: call.arguments,
        arguments: args, kind: args?.build_request_id ? 'observation' : 'start-attempt',
        toolResultIsError: message?.isError ?? null, code, buildReceipt: receipt,
        preDispatchInputValidation: message?.isError === true && !receipt
          && text.startsWith('Validation failed for tool "project_build":\n'),
        extraRoutingAttempt: call.name === 'tool_invoke' && code === 'tool_not_exposed' && !receipt }
    })
  return { attempts, startAttemptCount: attempts.filter(item => item.kind === 'start-attempt').length,
    admittedStartAttemptCount: attempts.filter(item => item.kind === 'start-attempt' && !item.preDispatchInputValidation).length,
    preDispatchInputValidationCount: attempts.filter(item => item.preDispatchInputValidation).length,
    extraRoutingAttempt: attempts.some(item => item.extraRoutingAttempt),
    confirmedRequestIds: [...new Set(attempts.map(item => item.buildReceipt).filter(item => item?.version === 1
      && typeof item.requestId === 'string' && item.requestId.length > 0).map(item => item.requestId))],
    interpretation: 'All stored call attempts and their costs remain counted. An exact registry input-validation rejection occurs before the handler; admitted starts exclude only that rejection. Request-bound receipts and private execution/log checks separately identify the actual Host request.' }
}

/** A finished case keeps its own request interval, even when a later fixture
 * fails. Refreshing this summary also attributes late failures of an earlier
 * in-flight request to its original case instead of the next case. */
export function summarizeCaseTransport(network, window, { functionalPassed = false, expectedFaultKind = null } = {}) {
  const requests = (network?.requests ?? []).slice(window.startRequestIndex, window.endRequestIndex)
  const ids = new Set(requests.map(item => item.id).filter(Boolean))
  const within = item => item.requestId ? ids.has(item.requestId)
    : Number.isFinite(item.at) && item.at >= window.startedAt && (window.endedAt === undefined || item.at <= window.endedAt)
  const faults = (network?.faults ?? []).filter(within)
  const unexpectedTransportFailures = (network?.failures ?? []).filter(within)
  const unattributedTransportFailures = (network?.failures ?? []).filter(item => !item.requestId && !Number.isFinite(item.at))
  const nonApiHttpErrors = []
  for (const item of requests.filter(item => Number.isFinite(item.status) && item.status >= 400)) {
    const failure = { code: 'upstream-http-status', requestId: item.id, method: item.method,
      path: item.path, status: item.status, at: item.headersReceivedAt }
    if (item.path.startsWith('/api/')) unexpectedTransportFailures.push(failure)
    else nonApiHttpErrors.push(failure)
  }
  const expected = faults.filter(item => item.kind === expectedFaultKind)
  for (const item of faults.filter(item => item.kind !== expectedFaultKind))
    unexpectedTransportFailures.push({ code: 'unexpected-injected-fault', requestId: item.requestId, kind: item.kind, at: item.at })
  const incompleteRequestIds = requests.filter(item => item.upstreamRequestStartedAt && !item.requestClosedAt).map(item => item.id)
  const expectedInjectedFault = expectedFaultKind ? { kind: expectedFaultKind, expectedCount: 1,
    observedCount: expected.length, confirmed: expected.length === 1 } : null
  const performanceExclusionReasons = [
    ...(!functionalPassed ? ['functional-not-passed'] : []),
    ...(expectedFaultKind || faults.length ? ['injected-fault-scenario'] : []),
    ...(unexpectedTransportFailures.length ? ['unexpected-transport-failure'] : []),
    ...(unattributedTransportFailures.length ? ['transport-failure-attribution-unavailable'] : []),
    ...(incompleteRequestIds.length ? ['transport-still-in-flight'] : [])]
  const posts = requests.filter(modelPost)
  return { functionalPassed, performanceEligible: performanceExclusionReasons.length === 0,
    expectedInjectedFault, unexpectedTransportFailures, unattributedTransportFailures, nonApiHttpErrors, performanceExclusionReasons,
    transportMeasurement: { requestIds: requests.map(item => item.id).filter(Boolean),
      httpSendCount: requests.every(item => Object.hasOwn(item, 'upstreamRequestStartedAt'))
        ? requests.filter(item => item.upstreamRequestStartedAt).length : null,
      receivedHttpResponseCount: requests.every(item => Object.hasOwn(item, 'headersReceivedAt'))
        ? requests.filter(item => item.headersReceivedAt).length : null,
      modelPostCount: posts.length, modelReposts: posts.filter(item => item.repostOf).map(item => ({ requestId: item.id,
        repostOf: item.repostOf, source: item.source, attemptForOriginalStep: item.attemptForOriginalStep })),
      bodyBytes: sumBytes(requests, 'bodyBytes'), modelBodyBytes: sumBytes(posts, 'bodyBytes'),
      modelPayloadBytesIncludingReposts: sumBytes(posts, 'payloadBytes'),
      responseBodyBytes: sumBytes(requests, 'responseBodyBytes'), downstreamBodyBytes: sumBytes(requests, 'downstreamBodyBytes'),
      incompleteRequestIds, socketBytes: null, headersAndTlsBytes: null,
      errorScope: 'all upstream/proxy I/O failures and /api/* HTTP errors affect eligibility; non-API HTTP statuses are retained separately',
      byteAccounting: 'HTTP entity bytes only; complete request field is repeated per POST; provider cacheRead is token reuse, not network bytes' } }
}

/** Explicit old-package arm only. The ordinary acceptance still binds the
 * package to current source. This verifies the already sealed bytes instead,
 * and never claims that an old package contains the current working tree. */
export async function verifySealedComparisonBaseline({ receiptFile, installedRoot, executablePath, artifact }) {
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'))
  assert.equal(receipt.immutable, true)
  const chat = receipt.artifacts.find(item => item.kind === 'chat')
  const host = receipt.artifacts.find(item => item.kind === 'host')
  assert.ok(chat && host && same(chat.target, installedRoot))
  assert.ok(same(path.dirname(executablePath), host.target))
  const executableRelative = path.relative(host.target, executablePath).replaceAll('\\', '/')
  assert.ok(Object.hasOwn(host.inventory, executableRelative), 'Use the actual executable from the sealed inventory')
  assert.equal(artifact.inputHash, chat.build.inputHash)
  assert.equal(artifact.outputHash, chat.build.outputHash)
  assert.equal(sha(JSON.stringify(chat.inventory)), chat.inventorySha256)
  // Portable verification has already checked every product output, including
  // the executing bundle. Bind the recorded receipt bytes as well.
  const recorded = chat.inventory['runtime/build-evidence.json']
  const bytes = await fs.readFile(path.join(installedRoot, 'runtime/build-evidence.json'))
  assert.equal(bytes.length, recorded.bytes); assert.equal(sha(bytes), recorded.sha256)
  for (const item of [chat, host]) {
    assert.equal(sha(JSON.stringify(item.inventory)), item.inventorySha256)
    const actualFiles = []
    const visit = async (directory, relative = '') => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false, 'Sealed packages cannot introduce symlinks')
        const child = relative ? relative + '/' + entry.name : entry.name
        if (entry.isDirectory()) await visit(path.join(directory, entry.name), child)
        else { assert.equal(entry.isFile(), true); actualFiles.push(child) }
      }
    }
    await visit(item.target)
    assert.deepEqual(actualFiles.sort(), Object.keys(item.inventory).sort(), 'The complete sealed file set must match')
    for (const [relative, recorded] of Object.entries(item.inventory)) {
      assert.ok(!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'))
      const file = path.join(item.target, relative), stat = await fs.lstat(file)
      assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.size, recorded.bytes)
      assert.equal(await fileHash(file), recorded.sha256, 'The sealed artifact must retain its exact bytes')
    }
  }
  assert.equal(await fileHash(path.join(host.target, 'resources/app.asar')), host.asarSha256)
  return { mode: 'sealed-before-artifact', sourceCurrent: false, receiptFile,
    receiptSha256: sha(await fs.readFile(receiptFile)), inputHash: artifact.inputHash,
    outputHash: artifact.outputHash, asarSha256: host.asarSha256 }
}

/** Retain provider evidence from actual UI-session messages. A preset name is
 * not proof of the routed model, and reasoning tokens are a subset of output. */
export function summarizeOnlineComparison(snapshot, { startedAt, expectedModel, expectedPreset,
  businessActionNames = ['project_build', 'edit', 'abs_apply', 'abs_import'], userStopObserved = false, transport } = {}) {
  const messages = snapshot?.messages ?? []
  const localAborts = messages.filter(item => userStopObserved && item.role === 'assistant' && item.usage
    && !item.responseId && !item.responseModel && !item.responsePresetId && !item.responseQuotaSnapshot
    && ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'].every(key => !item.usage[key])
    && (item.content ?? []).length === 0
    && (item.stopReason === 'aborted' || item.stopReason === 'error' && item.errorMessage === 'This operation was aborted'))
  const samples = messages.filter(item => item.role === 'assistant' && item.usage && !localAborts.includes(item)).map(item => ({
    at: item.timestamp, responseId: item.responseId, preset: item.responsePresetId,
    effectiveModel: item.responseModel, stopReason: item.stopReason, usage: item.usage,
    toolNames: (item.content ?? []).filter(part => part.type === 'toolCall')
      .map(part => part.name === 'tool_invoke' ? part.arguments?.name : part.name)
  }))
  const calls = messages.filter(item => item.role === 'assistant').flatMap(item => (item.content ?? [])
    .filter(part => part.type === 'toolCall').map(part => ({ id: part.id, requestPreparationAt: item.timestamp,
      name: part.name === 'tool_invoke' ? part.arguments?.name : part.name })))
  const business = calls.find(item => businessActionNames.includes(item.name))
  const timing = business && (snapshot.entries ?? []).find(entry => entry.type === 'custom' && entry.customType === 'aily.tool-timing'
    && entry.data?.toolCallId === business.id && Number.isFinite(entry.data.startedAt))?.data
  const first = business && { ...business, executionStartedAt: timing?.startedAt ?? null }
  const totals = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens']
    .map(key => [key, samples.reduce((sum, item) => sum + (Number.isFinite(item.usage?.[key]) ? item.usage[key] : 0), 0)]))
  const providerTimings = (snapshot.entries ?? []).filter(entry => entry.type === 'custom' && entry.customType === 'aily.provider-timing')
    .map(({ data }) => {
      const posts = (transport?.requests ?? []).filter(item => modelPost(item) && item.at >= data.requestStartedAt && item.at <= data.completedAt)
      return { requestId: data.requestId, selectedModel: data.selectedModel, effectiveModel: data.effectiveModel,
      status: data.status, preparationStartedAt: data.preparationStartedAt, requestStartedAt: data.requestStartedAt,
      firstResponseAt: data.firstResponseAt, firstOutputAt: data.firstOutputAt, completedAt: data.completedAt,
      responseAttempts: data.responseAttempts, responseResets: data.responseResets,
      localRequestPreparationMs: elapsed(data.preparationStartedAt, data.requestStartedAt),
      firstReceivedHeadersEnvelopeMs: elapsed(data.requestStartedAt, data.firstResponseAt),
      firstMeaningfulStreamEventEnvelopeMs: elapsed(data.requestStartedAt, data.firstOutputAt),
      afterFirstMeaningfulStreamEventMs: elapsed(data.firstOutputAt, data.completedAt),
      operationObservations: (data.operationObservations ?? []).map(item => ({ phase: item.phase, kind: item.kind, status: item.status, at: item.at })),
      httpEvidence: transport ? { modelPostCount: posts.length,
        receivedHttpResponseCount: posts.every(item => Object.hasOwn(item, 'headersReceivedAt'))
          ? posts.filter(item => item.headersReceivedAt).length : null,
        requestIds: posts.map(item => item.id), bodyBytes: sumBytes(posts, 'bodyBytes'), payloadBytesIncludingReposts: sumBytes(posts, 'payloadBytes'),
        reasoningEfforts: [...new Set(posts.map(item => item.reasoningEffort).filter(value => typeof value === 'string'))],
        reasoningEffortComplete: posts.length > 0 && posts.every(item => typeof item.reasoningEffort === 'string'),
        originalStepKeys: [...new Set(posts.map(item => item.source?.originalStepKey).filter(Boolean))],
        repostRequestIds: posts.filter(item => item.repostOf).map(item => item.id) } : null }
    })
  const toolExecutionTimings = (snapshot.entries ?? []).filter(entry => entry.type === 'custom' && entry.customType === 'aily.tool-timing')
    .map(({ data }) => ({ ...data, actualName: calls.find(call => call.id === data.toolCallId)?.name ?? data.toolName }))
  const mismatches = samples.filter(item => !item.effectiveModel || expectedModel && item.effectiveModel !== expectedModel
    || expectedPreset && item.preset !== expectedPreset)
  // A fresh session can persist its initial selection after the UI submit
  // invocation. Bind configuration to actual provider preparation; the UI
  // start remains unchanged for all latency measurements.
  const thinking = taskThinking(snapshot.entries, providerTimings[0]?.preparationStartedAt)
  return { sampleCount: samples.length, logicalResponseCount: samples.length, excludedProvenLocalAbortCount: localAborts.length, samples, usage: totals,
    expectedModel, expectedPreset, effectiveModels: [...new Set(samples.map(item => item.effectiveModel).filter(Boolean))],
    modelEvidenceValid: samples.length > 0 && mismatches.length === 0,
    tools: calls.map(item => item.name), businessActionNames, firstBusinessAction: first,
    firstBusinessActionAfterMs: first?.executionStartedAt !== null && first && Number.isFinite(startedAt)
      ? first.executionStartedAt - startedAt : null,
    requestPreparationProxyAfterMs: first && Number.isFinite(startedAt) ? first.requestPreparationAt - startedAt : undefined,
    providerTimings, toolExecutionTimings, todo: summarizeTodoProgress(snapshot),
    timingBoundaries: { responseAttempts: 'received provider HTTP responses, not HTTP sends or failed pre-response attempts',
      firstResponseAt: 'first received response callback; includes any prior failure/recovery envelope',
      firstOutputAt: 'first meaningful stream event, including thinking; not pure network TTFT or final answer',
      toolExecution: 'includes argument validation, beforeToolCall gates, handler and afterToolCall; not pure compiler time',
      beforeFirstProvider: 'unseparated UI/session/hook/history/ABS preparation envelope; no pure hostBeforeTurn clock',
      pureReasoningMs: null },
    logicalPayloads: (snapshot.entries ?? []).filter(entry => entry.type === 'custom' && entry.customType === 'aily.wire-context')
      .map(({ data }) => ({ payloadBytes: data.payloadBytes, preHookPayloadBytes: data.preHookPayloadBytes,
        payloadHash: data.payloadHash, prefixStable: data.prefixStable })),
    taskThinking: thinking,
    thinkingLevels: thinking.levels,
    thinkingEvidenceSource: 'session selection at first provider preparation and subsequent changes; UI submit latency is unchanged; setup transitions retained in taskThinking.sessionLevels; actual HTTP reasoning_effort is separately verified for every provider request',
    userTextBytes: messages.filter(item => item.role === 'user').reduce((sum, item) => sum + textBytes(item), 0),
    userTurns: messages.filter(item => item.role === 'user').length }
}

/** A strict complete-document expectation: this task changes one existing
 * numeric field and leaves every other block, input, comment and coordinate. */
export function singleFieldExpectedDocument(document, blockId, field, oldValue, newValue) {
  const result = structuredClone(document)
  let found = 0
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (value.id === blockId) {
      assert.equal(value.fields?.[field], oldValue); value.fields[field] = newValue; found++
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child)
  }
  visit(result); assert.equal(found, 1)
  return result
}
