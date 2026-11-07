import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

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
  return { sampleCount: samples.length, excludedProvenLocalAbortCount: localAborts.length, samples, usage: totals,
    expectedModel, expectedPreset, effectiveModels: [...new Set(samples.map(item => item.effectiveModel).filter(Boolean))],
    modelEvidenceValid: samples.length > 0 && mismatches.length === 0,
    tools: calls.map(item => item.name), businessActionNames, firstBusinessAction: first,
    firstBusinessActionAfterMs: first?.executionStartedAt !== null && first && Number.isFinite(startedAt)
      ? first.executionStartedAt - startedAt : null,
    requestPreparationProxyAfterMs: first && Number.isFinite(startedAt) ? first.requestPreparationAt - startedAt : undefined,
    providerTimings, toolExecutionTimings,
    timingBoundaries: { responseAttempts: 'received provider HTTP responses, not HTTP sends or failed pre-response attempts',
      firstResponseAt: 'first received response callback; includes any prior failure/recovery envelope',
      firstOutputAt: 'first meaningful stream event, including thinking; not pure network TTFT or final answer',
      toolExecution: 'includes argument validation, beforeToolCall gates, handler and afterToolCall; not pure compiler time',
      beforeFirstProvider: 'unseparated UI/session/hook/history/ABS preparation envelope; no pure hostBeforeTurn clock',
      pureReasoningMs: null },
    logicalPayloads: (snapshot.entries ?? []).filter(entry => entry.type === 'custom' && entry.customType === 'aily.wire-context')
      .map(({ data }) => ({ payloadBytes: data.payloadBytes, preHookPayloadBytes: data.preHookPayloadBytes,
        payloadHash: data.payloadHash, prefixStable: data.prefixStable })),
    thinkingLevels: [...new Set((snapshot.entries ?? []).filter(entry => entry.type === 'thinking_level_change')
      .map(entry => entry.thinkingLevel).filter(level => typeof level === 'string'))],
    thinkingEvidenceSource: 'session thinking_level_change; actual HTTP request reasoning_effort is recorded separately per provider',
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
