import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

const sha = value => createHash('sha256').update(value).digest('hex')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
const operationPath = /^\/api\/v3\/interactions\/([^/]+)\/operations\/(\d+)\/(state|events|result)$/

// Record identities and byte counts only. Leases, tokens, messages, tool
// arguments and response text must never enter the network evidence.
function requestSource(method, pathname, body, headers) {
  const step = pathname.match(/^\/api\/v3\/interactions\/([^/]+)\/steps$/)
  const observation = pathname.match(operationPath)
  if (method === 'POST' && step && Number.isSafeInteger(body?.stepIndex)) return {
    kind: 'step', interactionId: step[1], stepIndex: body.stepIndex,
    originalStepKey: `${step[1]}:${body.stepIndex}`,
    submissionIdHash: typeof headers['x-aily-step-submission-id'] === 'string' ? sha(headers['x-aily-step-submission-id']) : null,
    requestSha256: digest(headers['x-aily-step-request-sha256']) }
  if (method === 'POST' && pathname === '/api/v3/interactions') return {
    kind: 'create', originalStepKey: typeof body?.idempotencyKey === 'string' ? 'create:' + sha(body.idempotencyKey) : null }
  if (method === 'GET' && observation) return {
    kind: 'observation', interactionId: observation[1], stepIndex: Number(observation[2]),
    originalStepKey: `${observation[1]}:${Number(observation[2])}`, observation: observation[3],
    submissionIdHash: typeof headers['x-aily-step-submission-id'] === 'string' ? sha(headers['x-aily-step-submission-id']) : null,
    requestSha256: digest(headers['x-aily-step-request-sha256']) }
  return { kind: 'other', originalStepKey: null }
}

function claimObservation(raw, source) {
  let value
  try { value = JSON.parse(raw) } catch { return null }
  const receipt = value?.stepSubmission, recovery = value?.stepSubmissionRecovery
  const disposition = ['not_claimed', 'preparing', 'expired', 'started'].includes(recovery?.disposition)
    ? recovery.disposition : receipt?.accepted === true ? 'accepted' : null
  const proof = disposition === 'accepted' ? receipt : recovery
  if (!disposition) return null
  return { disposition, acceptedReceiptObserved: receipt?.accepted === true,
    originalStepMatches: proof.interactionId === source.interactionId && proof.stepIndex === source.stepIndex,
    requestHashMatches: source.requestSha256 ? proof.requestSha256 === source.requestSha256 : null,
    submissionHashMatches: source.submissionIdHash && typeof proof.submissionId === 'string'
      ? sha(proof.submissionId) === source.submissionIdHash : null,
    requestSha256: digest(proof.requestSha256), canonicalStateSha256: digest(proof.canonicalStateSha256),
    submissionIdHash: typeof proof.submissionId === 'string' ? sha(proof.submissionId) : null }
}
const headersFor = headers => {
  const value = { ...headers }
  for (const key of ['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade']) delete value[key]
  return value
}

/** Transparent, bounded network fault: after a real build result is submitted
 * to the real Services, drop one downstream SSE response before its first byte.
 * The upstream keeps running and is drained. No receipt/event/tool result is
 * generated, modified, cached or replayed here. Multiple user turns are allowed. */
export async function createBuildLogNetwork({ upstreamOrigin, upstreamAddress }) {
  const base = new URL(upstreamOrigin)
  assert.ok(['http:', 'https:'].includes(base.protocol) && base.pathname === '/' && !base.username && !base.password)
  if (upstreamAddress !== undefined) assert.ok(isIP(upstreamAddress), 'An explicitly pinned upstream must be an IP address')
  const pinned = upstreamAddress ? { lookup(hostname, options, callback) {
    assert.equal(hostname, base.hostname)
    const family = isIP(upstreamAddress)
    if (options?.all) callback(null, [{ address: upstreamAddress, family }])
    else callback(null, upstreamAddress, family)
  } } : {}
  const transport = base.protocol === 'https:' ? https : http
  const active = new Set(), tools = new Map(), requests = [], faults = [], failures = [], operations = new Map()
  let armed = false, capturedBuild
  const server = http.createServer((request, response) => {
    const receivedAt = Date.now()
    const url = new URL(request.url, 'http://127.0.0.1')
    const trace = { id: `http-${requests.length + 1}`, method: request.method, path: url.pathname,
      at: receivedAt, receivedAt, bodyReadCompletedAt: null, forwarded: false,
      source: { kind: 'unknown', originalStepKey: null }, bodyBytes: 0, payloadBytes: null, bodySha256: null, reasoningEffort: null,
      upstreamRequestStartedAt: null, upstreamBodyWriteCompletedAt: null, headersReceivedAt: null, status: null,
      firstResponseBodyAt: null, responseBodyBytes: 0, downstreamBodyBytes: 0, responseCompletedAt: null, requestClosedAt: null }
    // Reserve the request before buffering its body: a delayed or failed body
    // must keep the case that actually received it, not the following case.
    requests.push(trace)
    const fail = (code, extra = {}) => failures.push({ code, requestId: trace.id,
      originalStepKey: trace.source.originalStepKey, at: Date.now(), ...extra })
    void (async () => {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length; trace.bodyBytes = size; assert.ok(size <= 8 * 1024 * 1024)
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks)
      let body
      try { if (raw.length) body = JSON.parse(raw.toString()) } catch { /* Real server validates. */ }
      const source = requestSource(request.method, url.pathname, body, request.headers)
      Object.assign(trace, { bodyReadCompletedAt: Date.now(), source,
        payloadBytes: body && Object.hasOwn(body, 'request') ? Buffer.byteLength(JSON.stringify(body.request), 'utf8') : null,
        reasoningEffort: ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(body?.request?.reasoning_effort)
          ? body.request.reasoning_effort : null,
        bodySha256: sha(raw) })
      const step = request.method === 'POST' && /\/api\/v3\/interactions\/[^/]+\/steps$/.test(url.pathname)
      const results = body?.action?.kind === 'tool_results' ? body.action.payload?.results : undefined
      const buildResult = Array.isArray(results) && results.map(result => {
        let value
        try { value = JSON.parse((result.result?.content ?? result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')) } catch {}
        return { result, value }
      }).find(({ result, value }) => (result.toolName === 'project_build'
          || tools.get(result.toolCallId ?? result.tool_call_id) === 'project_build'
          || value?.verification?.scope === 'project-compilation')
        && value?.buildReceipt?.version === 1 && value.buildReceipt.state === 'completed')
      let drop = false
      if (armed && step && buildResult) {
        capturedBuild = buildResult.value.buildReceipt.requestId
        assert.ok(typeof capturedBuild === 'string', 'The fault must follow an actual request-bound build result')
        armed = false; drop = true
      }
      let dropped = false
      trace.upstreamRequestStartedAt = Date.now(); trace.forwarded = true
      const upstream = transport.request(new URL(url.pathname + url.search, base), { method: request.method, agent: false, ...pinned,
        headers: { ...headersFor(request.headers), host: base.host, 'accept-encoding': 'identity' } }, reply => {
        trace.headersReceivedAt = Date.now(); trace.status = reply.statusCode
        const sse = String(reply.headers['content-type'] ?? '').includes('text/event-stream')
        const decoder = new StringDecoder('utf8')
        let buffered = '', observationBytes = 0, observationChunks = []
        if (!drop || !sse || reply.statusCode !== 200) response.writeHead(reply.statusCode, headersFor(reply.headers))
        reply.on('data', chunk => {
          trace.firstResponseBodyAt ??= Date.now()
          trace.responseBodyBytes += chunk.length
          if (drop && sse && reply.statusCode === 200 && !dropped) {
            dropped = true
            faults.push({ kind: 'accepted-build-result-sse-disconnect', path: url.pathname, step: body.stepIndex,
              buildRequestId: capturedBuild, at: Date.now(), realUpstreamStatus: reply.statusCode,
              requestId: trace.id, originalStepKey: source.originalStepKey })
            response.destroy()
          } else if (!dropped && !response.destroyed) { response.write(chunk); trace.downstreamBodyBytes += chunk.length }
          if (!sse) {
            if (source.kind === 'observation' && observationBytes <= 8192) {
              observationBytes += chunk.length
              if (observationBytes <= 8192) observationChunks.push(chunk)
              else observationChunks = []
            }
            return
          }
          buffered = (buffered + decoder.write(chunk)).replaceAll('\r\n', '\n')
          if (buffered.length > 1024 * 1024) { fail('sse-frame-over-limit'); buffered = ''; return }
          let end
          while ((end = buffered.indexOf('\n\n')) >= 0) {
            const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2)
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
            try {
              const event = JSON.parse(data)
              if (event.type === 'tool_call_begin') tools.set(event.toolCallId,
                event.toolName === 'tool_invoke' ? event.input?.name : event.toolName)
              if (typeof event.operationId === 'string' && Number.isSafeInteger(event.seq)) {
                const operation = operations.get(event.operationId) ?? { operationId: event.operationId, maxSequence: 0, terminal: false }
                operation.maxSequence = Math.max(operation.maxSequence, event.seq)
                if (event.type === 'turn_end') operation.terminal = true
                operations.set(event.operationId, operation)
              }
            } catch { /* Observe valid unchanged frames only. */ }
          }
        })
        reply.once('end', () => {
          trace.responseCompletedAt = Date.now()
          if (source.kind === 'observation' && observationBytes <= 8192)
            trace.claimObservation = claimObservation(Buffer.concat(observationChunks).toString('utf8'), source)
          if (drop && !dropped) fail('armed-result-without-sse-frame', { status: reply.statusCode })
          if (!dropped && !response.destroyed) response.end()
        })
        reply.once('error', error => { fail('upstream-response', { networkCode: error.code }); response.destroy() })
      })
      active.add(upstream)
      upstream.once('socket', socket => socket.once('connect', () => {
        const peer = socket.remoteAddress?.replace(/^::ffff:/, '')
        trace.upstreamAddress = peer
        if (upstreamAddress && peer !== upstreamAddress) {
          fail('upstream-address-mismatch')
          upstream.destroy(new Error('The connection did not reach the explicitly pinned test server'))
        }
      }))
      upstream.once('finish', () => { trace.upstreamBodyWriteCompletedAt = Date.now() })
      upstream.once('close', () => { trace.requestClosedAt = Date.now(); active.delete(upstream) })
      upstream.once('error', error => { fail('upstream-request', { networkCode: error.code }); response.destroy() })
      // A disconnected consumer never kills an accepted upstream model operation.
      upstream.end(raw)
    })().catch(error => { fail('proxy-request', { name: error.name }); response.destroy() })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`,
    armAfterBuildResult() { assert.equal(faults.length, 0); assert.equal(armed, false); armed = true },
    snapshot: () => {
      const originals = new Map()
      const observedRequests = requests.map(item => {
        const result = structuredClone(item), key = result.source.originalStepKey
        const prior = key && result.source.kind !== 'observation' ? originals.get(key) : null
        result.attemptForOriginalStep = key && result.source.kind !== 'observation' ? (prior?.count ?? 0) + 1 : null
        result.repostOf = prior?.id ?? null
        if (result.attemptForOriginalStep) originals.set(key, { id: prior?.id ?? result.id, count: result.attemptForOriginalStep })
        return result
      })
      return { transparentRealUpstream: true, syntheticOutput: false, fabricatedToolResults: false,
      measurement: { version: 2, bodyBytes: 'received HTTP entity bytes, including the full request and wrapper',
        httpSendCount: 'Node upstream ClientRequest submissions, including attempts failing before a response; not server admission',
        forwarded: 'legacy flag meaning an upstream attempt was prepared, not proof of delivery',
        payloadBytes: 'UTF-8 JSON serialization of the complete request field; repeated per POST',
        reasoningEffort: 'allowlisted scalar request.reasoning_effort observed from the unchanged HTTP body; session selection is separate',
        upstreamBodyWriteCompletedAt: 'Node finished writing the request; does not prove server acceptance',
        responseBodyBytes: 'upstream HTTP entity bytes read, including bytes drained after an injected downstream drop',
        downstreamBodyBytes: 'HTTP entity bytes passed to the local response writer; not acknowledged receipt',
        socketBytes: null, headersAndTlsBytes: null, cacheReadIsNetworkBytes: false },
      ...(upstreamAddress ? { pinnedUpstreamAddress: upstreamAddress, tlsHostname: base.hostname } : {}),
      armed, capturedBuildRequestId: capturedBuild, requests: observedRequests, faults: structuredClone(faults),
      failures: structuredClone(failures), operations: [...operations.values()].map(item => ({ ...item })),
      requestHashes: requests.map(item => sha(item.method + ' ' + item.path)) }
    },
    async close() {
      for (const request of active) request.destroy()
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections(); await closed
    } }
}
