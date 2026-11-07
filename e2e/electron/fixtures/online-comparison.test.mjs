import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { summarizeOnlineComparison, summarizeCaseTransport, singleFieldExpectedDocument, verifySealedComparisonBaseline } from './online-comparison.mjs'
import { createBuildLogNetwork } from './build-log-network.mjs'

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function withLocalNetwork(handler, run) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const proxy = await createBuildLogNetwork({ upstreamOrigin: `http://127.0.0.1:${server.address().port}`,
    upstreamAddress: '127.0.0.1' })
  try { await run(proxy) } finally {
    await proxy.close()
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed
  }
}
async function closedSnapshot(proxy) {
  for (let count = 0; count < 100; count++) {
    const network = proxy.snapshot()
    if (network.requests.every(item => item.requestClosedAt)) return network
    await wait(5)
  }
  assert.fail('The local-only network fixture did not settle')
}

test('comparison records actual model, sampled usage and first business action without double counting reasoning', () => {
  const snapshot = { messages: [{ role: 'user', content: [{ type: 'text', text: '编译' }] },
    { role: 'assistant', timestamp: 1100, content: [{ type: 'toolCall', name: 'read', arguments: { path: 'skills/verification.md' } }] },
    { role: 'assistant', timestamp: 1200, responseModel: 'glm-5.3-flash', responsePresetId: 'auto-fast',
      usage: { input: 10, output: 4, reasoning: 3, cacheRead: 20, totalTokens: 34 },
      content: [{ type: 'toolCall', name: 'tool_load' }] },
    { role: 'assistant', timestamp: 1300, responseModel: 'glm-5.3-flash', responsePresetId: 'auto-fast',
      usage: { input: 20, output: 5, reasoning: 4, cacheRead: 30, totalTokens: 55 },
      content: [{ type: 'toolCall', id: 'build-call', name: 'tool_invoke', arguments: { name: 'project_build' } }] }],
    entries: [{ type: 'custom', customType: 'aily.tool-timing', data: { toolCallId: 'build-call', startedAt: 1400 } }] }
  const result = summarizeOnlineComparison(snapshot, { startedAt: 1000, expectedModel: 'glm-5.3-flash', expectedPreset: 'auto-fast',
    businessActionNames: ['project_build'] })
  assert.equal(result.sampleCount, 2); assert.equal(result.usage.output, 9); assert.equal(result.usage.reasoning, 7)
  assert.equal(result.usage.totalTokens, 89); assert.equal(result.modelEvidenceValid, true)
  assert.deepEqual(result.firstBusinessAction, { id: 'build-call', requestPreparationAt: 1300, name: 'project_build', executionStartedAt: 1400 })
  assert.equal(result.firstBusinessActionAfterMs, 400); assert.equal(result.requestPreparationProxyAfterMs, 300)
  assert.equal(summarizeOnlineComparison({ messages: snapshot.messages }).firstBusinessActionAfterMs, null)
  snapshot.messages[3].responseModel = 'fallback-model'
  assert.equal(summarizeOnlineComparison(snapshot, { expectedModel: 'glm-5.3-flash' }).modelEvidenceValid, false)
  delete snapshot.messages[3].responseModel
  assert.equal(summarizeOnlineComparison(snapshot).modelEvidenceValid, false)
})

test('only the observed user stop with empty local abort is excluded; missing actual model still fails', () => {
  const local = { role: 'assistant', stopReason: 'error', errorMessage: 'This operation was aborted', content: [],
    usage: { input: 0, output: 0, totalTokens: 0 } }
  const real = { role: 'assistant', responseId: 'actual-response', responseModel: 'glm-5.3', responsePresetId: 'auto-max',
    usage: { input: 10, output: 1 }, content: [] }
  const snapshot = { messages: [real, local] }
  assert.equal(summarizeOnlineComparison(snapshot, { expectedModel: 'glm-5.3' }).modelEvidenceValid, false)
  const valid = summarizeOnlineComparison(snapshot, { expectedModel: 'glm-5.3', userStopObserved: true })
  assert.equal(valid.excludedProvenLocalAbortCount, 1); assert.equal(valid.sampleCount, 1); assert.equal(valid.modelEvidenceValid, true)
  delete real.responseModel
  assert.equal(summarizeOnlineComparison(snapshot, { userStopObserved: true }).modelEvidenceValid, false)
})

test('per-case eligibility retains recovered timeout and attributes late failures to the original request', () => {
  const network = { requests: [
    { id: 'first', at: 100, method: 'POST', path: '/api/v3/interactions', upstreamRequestStartedAt: 101,
      headersReceivedAt: 102, status: 200, requestClosedAt: 103, bodyBytes: 500, payloadBytes: 450 },
    { id: 'second', at: 200, method: 'POST', path: '/api/v3/interactions/x/steps', upstreamRequestStartedAt: 201,
      headersReceivedAt: 202, status: 200, requestClosedAt: 203 }], faults: [], failures: [] }
  const first = { startedAt: 90, endedAt: 150, startRequestIndex: 0, endRequestIndex: 1 }
  const second = { startedAt: 160, endedAt: 250, startRequestIndex: 1, endRequestIndex: 2 }
  assert.equal(summarizeCaseTransport(network, first, { functionalPassed: true }).performanceEligible, true)
  // A suite/fixture failure after this completed case cannot erase its pass.
  assert.equal(summarizeCaseTransport(network, second).functionalPassed, false)
  assert.equal(summarizeCaseTransport(network, first, { functionalPassed: true }).performanceEligible, true)
  // This late transport failure belongs to first even though its timestamp is
  // in the second case. Functional recovery is still a separate passed fact.
  network.failures.push({ requestId: 'first', at: 210, code: 'upstream-request', networkCode: 'ETIMEDOUT' })
  const recovered = summarizeCaseTransport(network, first, { functionalPassed: true })
  assert.equal(recovered.functionalPassed, true); assert.equal(recovered.performanceEligible, false)
  assert.equal(recovered.unexpectedTransportFailures[0].networkCode, 'ETIMEDOUT')
  assert.equal(summarizeCaseTransport(network, second, { functionalPassed: true }).performanceEligible, true)
  delete network.requests[0].requestClosedAt
  assert.ok(summarizeCaseTransport(network, first, { functionalPassed: true }).performanceExclusionReasons.includes('transport-still-in-flight'))
  network.requests[1].status = 503
  assert.equal(summarizeCaseTransport(network, second, { functionalPassed: true }).unexpectedTransportFailures[0].code, 'upstream-http-status')
  const legacy = summarizeCaseTransport({ requests: [{ method: 'POST', path: '/api/v3/interactions', at: 100 }],
    failures: [{ code: 'upstream-request', networkCode: 'ETIMEDOUT' }] }, first, { functionalPassed: true })
  assert.equal(legacy.performanceEligible, false)
  assert.equal(legacy.transportMeasurement.httpSendCount, null)
  assert.equal(legacy.transportMeasurement.bodyBytes, null)
  assert.equal(legacy.unattributedTransportFailures.length, 1)
})

test('provider counters do not masquerade as HTTP sends, pure reasoning or pure compiler clocks', () => {
  const snapshot = { entries: [
    { type: 'thinking_level_change', thinkingLevel: 'high' },
    { type: 'custom', customType: 'aily.provider-timing', data: { requestId: 'logical', preparationStartedAt: 90,
      requestStartedAt: 100, firstResponseAt: 300, firstOutputAt: 320, completedAt: 400, responseAttempts: 1,
      operationObservations: [{ phase: 'submission', kind: 'not_claimed', at: 250 }] } },
    { type: 'custom', customType: 'aily.wire-context', data: { payloadBytes: 1000, preHookPayloadBytes: 900 } }
  ] }
  const transport = { requests: [
    { id: 'a', at: 101, method: 'POST', path: '/api/v3/interactions/x/steps', bodyBytes: 1100, payloadBytes: 1000,
      headersReceivedAt: null, reasoningEffort: 'high', source: { originalStepKey: 'x:2' } },
    { id: 'b', at: 280, method: 'POST', path: '/api/v3/interactions/x/steps', bodyBytes: 1100, payloadBytes: 1000,
      headersReceivedAt: 300, reasoningEffort: 'high', repostOf: 'a', source: { originalStepKey: 'x:2' } }
  ] }
  const result = summarizeOnlineComparison(snapshot, { transport })
  const timing = result.providerTimings[0]
  assert.equal(timing.responseAttempts, 1); assert.equal(timing.httpEvidence.modelPostCount, 2)
  assert.equal(timing.httpEvidence.receivedHttpResponseCount, 1)
  assert.equal(timing.httpEvidence.payloadBytesIncludingReposts, 2000)
  assert.equal(timing.httpEvidence.bodyBytes, 2200)
  assert.deepEqual(timing.httpEvidence.repostRequestIds, ['b'])
  assert.deepEqual(timing.httpEvidence.reasoningEfforts, ['high'])
  assert.equal(timing.httpEvidence.reasoningEffortComplete, true)
  assert.equal(timing.firstReceivedHeadersEnvelopeMs, 200)
  assert.equal(result.timingBoundaries.pureReasoningMs, null)
  assert.match(result.timingBoundaries.toolExecution, /beforeToolCall/)
  assert.deepEqual(result.thinkingLevels, ['high'])
  assert.equal(result.logicalPayloads[0].payloadBytes, 1000)
  assert.equal(summarizeOnlineComparison({ entries: [{ type: 'custom', customType: 'aily.provider-timing', data: {} }] })
    .providerTimings[0].firstReceivedHeadersEnvelopeMs, null)
})

test('non-API resource HTTP failures remain visible but API errors and every socket failure exclude performance', () => {
  const network = { requests: [
    { id: 'resource', path: '/boards.json', method: 'GET', status: 404, at: 100, headersReceivedAt: 101, requestClosedAt: 102 },
    { id: 'api', path: '/api/v3/interactions', method: 'POST', status: 200, at: 110, headersReceivedAt: 111, requestClosedAt: 112 }
  ], failures: [], faults: [] }
  const window = { startedAt: 90, startRequestIndex: 0 }
  let result = summarizeCaseTransport(network, window, { functionalPassed: true })
  assert.equal(result.performanceEligible, true)
  assert.equal(result.nonApiHttpErrors.length, 1); assert.equal(result.nonApiHttpErrors[0].path, '/boards.json')
  assert.deepEqual(result.unexpectedTransportFailures, [])
  network.requests[1].status = 429
  result = summarizeCaseTransport(network, window, { functionalPassed: true })
  assert.equal(result.performanceEligible, false); assert.equal(result.unexpectedTransportFailures[0].status, 429)
  network.requests[1].status = 200
  network.failures.push({ requestId: 'resource', code: 'upstream-request', networkCode: 'ECONNRESET', at: 150 })
  result = summarizeCaseTransport(network, window, { functionalPassed: true })
  assert.equal(result.performanceEligible, false); assert.equal(result.unexpectedTransportFailures[0].networkCode, 'ECONNRESET')
})

test('real local HTTP accounting counts complete bodies, exact step reposts and bounded original-claim metadata without secrets', async () => {
  const observedBytes = []
  await withLocalNetwork((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      observedBytes.push(Buffer.concat(chunks).length)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ [request.url.includes('accepted=1') ? 'stepSubmission' : 'stepSubmissionRecovery']:
        { disposition: 'not_claimed', accepted: request.url.includes('accepted=1'), interactionId: 'actual',
        stepIndex: 2, requestSha256: 'a'.repeat(64), canonicalStateSha256: 'b'.repeat(64), submissionId: 'private-submission' },
        ignoredUserText: 'do-not-record-response-body' }))
    })
  }, async proxy => {
    const payload = { reasoning_effort: 'high', messages: [{ role: 'user', content: '私有正文 do-not-record-request-body' }] }
    const create = JSON.stringify({ request: payload, idempotencyKey: 'private-idempotency' })
    const step = JSON.stringify({ stepIndex: 2, lease: 'private-lease', action: { kind: 'tool_results', payload: { results: [] } }, request: payload })
    const post = async (url, body) => {
      const response = await fetch(proxy.origin + url, { method: 'POST', body,
        headers: { authorization: 'Bearer private-token', 'x-aily-step-submission-id': 'private-submission',
          'x-aily-step-request-sha256': 'a'.repeat(64) }, signal: AbortSignal.timeout(3000) })
      await response.text()
    }
    await post('/api/v3/interactions', create)
    await post('/api/v3/interactions/actual/steps', step)
    await post('/api/v3/interactions/actual/steps', step)
    await (await fetch(proxy.origin + '/api/v3/interactions/actual/operations/2/state?token=private-query-token')).text()
    await (await fetch(proxy.origin + '/api/v3/interactions/actual/operations/2/state?accepted=1', { headers: {
      'x-aily-step-submission-id': 'private-submission', 'x-aily-step-request-sha256': 'a'.repeat(64) } })).text()
    const network = await closedSnapshot(proxy)
    assert.deepEqual(network.failures, [])
    assert.deepEqual(network.requests.map(item => item.bodyBytes), observedBytes)
    assert.equal(network.requests[1].bodyBytes, Buffer.byteLength(step))
    assert.equal(network.requests[1].payloadBytes, Buffer.byteLength(JSON.stringify(payload)))
    assert.equal(network.requests[1].reasoningEffort, 'high')
    assert.equal(network.requests[2].repostOf, network.requests[1].id)
    assert.equal(network.requests[2].attemptForOriginalStep, 2)
    assert.equal(network.requests[3].source.originalStepKey, 'actual:2')
    assert.equal(network.requests[3].claimObservation.disposition, 'not_claimed')
    assert.equal(network.requests[3].claimObservation.originalStepMatches, true)
    assert.equal(network.requests[4].claimObservation.disposition, 'accepted')
    assert.equal(network.requests[4].claimObservation.acceptedReceiptObserved, true)
    assert.equal(network.requests[4].claimObservation.requestHashMatches, true)
    assert.equal(network.requests[4].claimObservation.submissionHashMatches, true)
    assert.ok(network.requests.every(item => item.headersReceivedAt && item.upstreamBodyWriteCompletedAt && item.responseBodyBytes > 0))
    const serialized = JSON.stringify(network)
    for (const secret of ['private-token', 'private-idempotency', 'private-lease', 'private-submission',
      'private-query-token', 'do-not-record-response-body', 'do-not-record-request-body']) assert.equal(serialized.includes(secret), false)
    const summary = summarizeCaseTransport(network, { startRequestIndex: 0, startedAt: 0 }, { functionalPassed: true })
    assert.equal(summary.performanceEligible, true); assert.equal(summary.transportMeasurement.httpSendCount, 5)
    assert.equal(summary.transportMeasurement.modelPostCount, 3)
    assert.equal(summary.transportMeasurement.modelReposts.length, 1)
    assert.equal(summary.transportMeasurement.modelPayloadBytesIncludingReposts, 3 * Buffer.byteLength(JSON.stringify(payload)))
  })
})

test('actual pre-response connection failure is associated with its HTTP send even with zero received responses', async () => {
  await withLocalNetwork(request => request.socket.destroy(), async proxy => {
    await assert.rejects(fetch(proxy.origin + '/api/v3/interactions', { method: 'POST',
      body: JSON.stringify({ idempotencyKey: 'same-original', request: {} }), signal: AbortSignal.timeout(3000) }))
    const network = await closedSnapshot(proxy)
    assert.equal(network.requests.length, 1); assert.equal(network.requests[0].headersReceivedAt, null)
    assert.equal(network.failures[0].requestId, network.requests[0].id)
    const summary = summarizeCaseTransport(network, { startRequestIndex: 0, startedAt: 0 }, { functionalPassed: true })
    assert.equal(summary.functionalPassed, true); assert.equal(summary.performanceEligible, false)
    assert.equal(summary.transportMeasurement.httpSendCount, 1)
    assert.equal(summary.transportMeasurement.receivedHttpResponseCount, 0)
  })
})

test('a delayed request body keeps its original receive interval and repost identity', async () => {
  await withLocalNetwork((request, response) => {
    request.resume(); request.on('end', () => response.end('{}'))
  }, async proxy => {
    const raw = JSON.stringify({ idempotencyKey: 'same-original', request: { messages: [] } })
    const original = http.request(proxy.origin + '/api/v3/interactions', { method: 'POST' })
    const done = new Promise((resolve, reject) => {
      original.once('error', reject)
      original.once('response', response => { response.resume(); response.once('end', resolve); response.once('error', reject) })
    })
    original.write(raw.slice(0, 10))
    for (let count = 0; !proxy.snapshot().requests.length && count < 100; count++) await wait(5)
    assert.equal(proxy.snapshot().requests.length, 1)
    assert.equal(proxy.snapshot().requests[0].bodyReadCompletedAt, null)
    await (await fetch(proxy.origin + '/api/v3/interactions', { method: 'POST', body: raw,
      signal: AbortSignal.timeout(3000) })).text()
    original.end(raw.slice(10)); await done
    const network = await closedSnapshot(proxy)
    assert.equal(network.requests[0].id, 'http-1'); assert.equal(network.requests[1].id, 'http-2')
    assert.ok(network.requests[0].bodyReadCompletedAt >= network.requests[1].bodyReadCompletedAt)
    assert.equal(network.requests[1].repostOf, 'http-1')
    assert.equal(network.requests[1].attemptForOriginalStep, 2)
    assert.equal(network.requests[0].bodyBytes, network.requests[1].bodyBytes)
  })
})

test('a real local downstream SSE drop remains explicit expected fault and never hides another failure', async () => {
  await withLocalNetwork((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"type":"turn_end","operationId":"actual:2","seq":1}\n\n')
    })
  }, async proxy => {
    proxy.armAfterBuildResult()
    const body = JSON.stringify({ stepIndex: 2, request: {}, action: { kind: 'tool_results', payload: { results: [
      { toolName: 'project_build', content: [{ type: 'text', text: JSON.stringify({ buildReceipt: {
        version: 1, state: 'completed', requestId: 'actual-build-request' } }) }] }] } } })
    await assert.rejects(async () => {
      const response = await fetch(proxy.origin + '/api/v3/interactions/actual/steps', { method: 'POST', body,
        signal: AbortSignal.timeout(3000) }); await response.text()
    })
    const network = await closedSnapshot(proxy), window = { startRequestIndex: 0, startedAt: 0 }
    assert.equal(network.faults.length, 1); assert.deepEqual(network.failures, [])
    const summary = summarizeCaseTransport(network, window, { functionalPassed: true,
      expectedFaultKind: 'accepted-build-result-sse-disconnect' })
    assert.equal(summary.expectedInjectedFault.confirmed, true)
    assert.equal(summary.functionalPassed, true); assert.equal(summary.performanceEligible, false)
    assert.deepEqual(summary.unexpectedTransportFailures, [])
    network.failures.push({ requestId: network.requests[0].id, code: 'upstream-request', networkCode: 'ETIMEDOUT' })
    assert.equal(summarizeCaseTransport(network, window, { functionalPassed: true,
      expectedFaultKind: 'accepted-build-result-sse-disconnect' }).unexpectedTransportFailures.length, 1)
  })
})

test('single-field expected document preserves full program and rejects ambiguous/missing target', () => {
  const original = { blocks: { blocks: [{ id: 'global', inputs: { A: { block: { id: 'probe', fields: { VALUE: 100 } } } } },
    { id: 'loop', extraState: { comments: 'retain' } }] } }
  const actual = singleFieldExpectedDocument(original, 'probe', 'VALUE', 100, 101)
  assert.equal(original.blocks.blocks[0].inputs.A.block.fields.VALUE, 100)
  assert.equal(actual.blocks.blocks[0].inputs.A.block.fields.VALUE, 101)
  assert.deepEqual(actual.blocks.blocks[1], original.blocks.blocks[1])
  assert.throws(() => singleFieldExpectedDocument(original, 'missing', 'VALUE', 100, 101))
  assert.throws(() => singleFieldExpectedDocument(original, 'probe', 'VALUE', 99, 101))
})

test('explicit sealed arm binds both manifests and rejects output tampering or a different host', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sealed-online-'))
  const chat = path.join(root, 'chat'), host = path.join(root, 'host'), receiptFile = path.join(root, 'receipt.json')
  const sha = value => createHash('sha256').update(value).digest('hex')
  try {
    await fs.mkdir(path.join(chat, 'runtime'), { recursive: true }); await fs.mkdir(path.join(host, 'resources'), { recursive: true })
    const build = { inputHash: 'old-input', outputHash: 'old-output' }, raw = JSON.stringify(build), asar = Buffer.from('sealed host')
    await fs.writeFile(path.join(chat, 'runtime/build-evidence.json'), raw)
    await fs.writeFile(path.join(host, 'resources/app.asar'), asar)
    await fs.writeFile(path.join(host, 'app.exe'), 'sealed exe')
    const chatInventory = { 'runtime/build-evidence.json': { bytes: Buffer.byteLength(raw), sha256: sha(raw) } }
    const hostInventory = { 'resources/app.asar': { bytes: asar.length, sha256: sha(asar) },
      'app.exe': { bytes: Buffer.byteLength('sealed exe'), sha256: sha('sealed exe') } }
    const receipt = { immutable: true, artifacts: [
      { kind: 'chat', target: chat, build, inventory: chatInventory, inventorySha256: sha(JSON.stringify(chatInventory)) },
      { kind: 'host', target: host, asarSha256: sha(asar), inventory: hostInventory, inventorySha256: sha(JSON.stringify(hostInventory)) }] }
    await fs.writeFile(receiptFile, JSON.stringify(receipt))
    const args = { receiptFile, installedRoot: chat, executablePath: path.join(host, 'app.exe'), artifact: build }
    assert.equal((await verifySealedComparisonBaseline(args)).sourceCurrent, false)
    await assert.rejects(verifySealedComparisonBaseline({ ...args, executablePath: path.join(root, 'other/app.exe') }))
    await assert.rejects(verifySealedComparisonBaseline({ ...args, executablePath: path.join(host, 'missing.exe') }))
    await fs.writeFile(path.join(host, 'extra.exe'), 'not sealed')
    await assert.rejects(verifySealedComparisonBaseline({ ...args, executablePath: path.join(host, 'extra.exe') }))
    await assert.rejects(verifySealedComparisonBaseline(args))
    await fs.unlink(path.join(host, 'extra.exe'))
    await fs.writeFile(path.join(chat, 'extra.txt'), 'not sealed')
    await assert.rejects(verifySealedComparisonBaseline(args))
    await fs.unlink(path.join(chat, 'extra.txt'))
    await fs.writeFile(path.join(host, 'resources/app.asar'), 'tampered')
    await assert.rejects(verifySealedComparisonBaseline(args))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
