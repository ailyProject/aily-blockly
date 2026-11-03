import http from 'node:http'
import { createHash } from 'node:crypto'

const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const MAX_CAPTURE_BYTES = 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[a-f0-9]{64}$/
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const requireValue = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }) }
const singleHeader = (request, name) => typeof request.headers[name] === 'string' ? request.headers[name] : undefined

/** Adds one lost response header boundary before the existing terminal-expiry
 * bridge. Only a completed, verified upstream SSE response is cached; its model
 * operation is never sent upstream again. All final expiry/result routes remain
 * the terminal bridge's responsibility. No source, body, token or raw lease is
 * included in public evidence.
 */
export async function createCombinedOperationFaultProxy({ upstreamOrigin, failAfterToolId = 'agent-edit-once' }) {
  const base = new URL(upstreamOrigin)
  requireValue(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port
    && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
  'proxy_upstream_must_be_local_origin')
  requireValue(typeof failAfterToolId === 'string' && failAfterToolId.length > 0 && failAfterToolId.length <= 128,
    'proxy_invalid_fault_tool')
  const requests = [], failures = [], activeUpstreams = new Set()
  let capture, claimed = false, forwarded = 0, dropped = 0, duplicatePosts = 0
  const json = (response, value, status = 200) => {
    const body = JSON.stringify(value)
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body) })
    response.end(body)
  }
  const open = (request, url, callback) => {
    const upstream = http.request(new URL(url.pathname + url.search, base), {
      method: request.method, headers: { ...request.headers, host: base.host }
    }, callback)
    activeUpstreams.add(upstream)
    upstream.once('close', () => activeUpstreams.delete(upstream))
    forwarded++
    return upstream
  }
  const passthrough = (request, response, url, body) => {
    const upstream = open(request, url, reply => {
      response.writeHead(reply.statusCode ?? 502, reply.headers)
      reply.once('error', () => response.destroy())
      reply.pipe(response)
    })
    upstream.once('error', () => {
      failures.push({ code: 'proxy_passthrough_upstream_failed', path: url.pathname })
      response.destroy()
    })
    request.once('aborted', () => upstream.destroy())
    response.once('close', () => { if (!response.writableFinished) upstream.destroy() })
    if (body !== undefined) upstream.end(body)
    else request.pipe(upstream)
  }
  const readBody = async request => {
    let bytes = 0
    const chunks = []
    for await (const chunk of request) {
      bytes += chunk.length
      requireValue(bytes <= MAX_REQUEST_BYTES, 'proxy_request_too_large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  const captureResponse = (request, url, body) => new Promise((resolve, reject) => {
    const upstream = open(request, url, reply => {
      let size = 0
      const chunks = []
      reply.once('error', () => reject(Object.assign(new Error('proxy_capture_upstream_failed'), { code: 'proxy_capture_upstream_failed' })))
      reply.on('data', chunk => {
        size += chunk.length
        if (size > MAX_CAPTURE_BYTES) {
          reject(Object.assign(new Error('proxy_capture_too_large'), { code: 'proxy_capture_too_large' }))
          reply.destroy()
          return
        }
        chunks.push(chunk)
      })
      reply.once('end', () => resolve({ status: reply.statusCode, headers: reply.headers, body: Buffer.concat(chunks) }))
    })
    upstream.once('error', () => reject(Object.assign(new Error('proxy_capture_upstream_failed'), { code: 'proxy_capture_upstream_failed' })))
    upstream.end(body)
  })
  const verifySse = (reply, operation) => {
    requireValue(reply.status === 200 && /^text\/event-stream(?:;|$)/i.test(reply.headers['content-type'] ?? ''),
      'proxy_capture_requires_successful_sse')
    requireValue(reply.headers['x-aily-operation-id'] === operation.operationId
      && reply.headers['x-aily-operation-step'] === String(operation.step), 'proxy_capture_operation_mismatch')
    let events
    try {
      events = reply.body.toString('utf8').replaceAll('\r\n', '\n').split('\n\n').flatMap(frame => {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        return data ? [JSON.parse(data)] : []
      })
    } catch { throw Object.assign(new Error('proxy_capture_invalid_sse'), { code: 'proxy_capture_invalid_sse' }) }
    requireValue(events.length > 0, 'proxy_capture_empty_sse')
    let sequence = 0
    for (const event of events) {
      requireValue(event.interactionId === operation.interactionId && event.operationId === operation.operationId
        && event.operationStepIndex === operation.step && Number.isSafeInteger(event.seq) && event.seq > sequence
        && event.sequence === event.seq, 'proxy_capture_event_identity_mismatch')
      sequence = event.seq
    }
    const terminal = events.at(-1)
    requireValue(terminal.type === 'turn_end' && terminal.stepIndex === operation.step + 1
      && terminal.continuation?.nextStepIndex === operation.step + 1
      && terminal.continuation?.status === 'waiting_tool_results'
      && terminal.continuation?.pendingState?.kind === 'tool_results', 'proxy_capture_requires_tool_continuation')
    return { sequence, nextStepIndex: terminal.stepIndex, status: 'waiting_tool_results', pendingKind: 'tool_results' }
  }
  const authorizeObservation = request => {
    requireValue(capture?.ready === true, 'proxy_submission_not_ready')
    requireValue(singleHeader(request, 'x-aily-step-submission-version') === '1'
      && singleHeader(request, 'x-aily-step-submission-id') === capture.submissionId
      && singleHeader(request, 'x-aily-step-request-sha256') === capture.requestSha256
      && sha(singleHeader(request, 'x-aily-step-original-lease') ?? '') === capture.originalLeaseSha256,
    'proxy_submission_observation_mismatch')
  }
  const handle = async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const trace = { method: request.method, path: url.pathname, role: 'passthrough' }
    requests.push(trace)
    if (capture && request.method === 'GET'
      && [capture.statePath, capture.eventsPath].includes(url.pathname)) {
      trace.role = 'protected-recovery'
      authorizeObservation(request)
      if (url.pathname === capture.statePath) {
        capture.stateReads++
        json(response, { interactionId: capture.interactionId, operationId: capture.operationId,
          operationStepIndex: capture.step, stepIndex: capture.nextStepIndex,
          status: capture.status, pendingKind: capture.pendingKind, lastSequence: capture.sequence,
          streamState: 'terminal', recovery: { reason: null, canonicalOnly: true, responseComplete: false },
          stepSubmission: { version: 1, submissionId: capture.submissionId, requestSha256: capture.requestSha256,
            originalLeaseSha256: capture.originalLeaseSha256, stepIndex: capture.step,
            operationId: capture.operationId, accepted: true, interactionId: capture.interactionId } })
      } else {
        requireValue(capture.stateReads > 0 && url.searchParams.size === 1 && url.searchParams.get('after') === '0',
          'proxy_events_require_original_zero_cursor')
        capture.eventReads++
        response.writeHead(200, { 'content-type': capture.reply.headers['content-type'], 'cache-control': 'no-store',
          'x-aily-operation-id': capture.operationId, 'x-aily-operation-step': String(capture.step),
          'content-length': capture.reply.body.length })
        response.end(capture.reply.body)
      }
      return
    }
    const match = request.method === 'POST' && url.pathname.match(/^\/api\/v3\/interactions\/([A-Za-z0-9_-]{1,128})\/steps$/)
    if (!match) { passthrough(request, response, url); return }
    const raw = await readBody(request)
    let body
    try { body = JSON.parse(raw) } catch { /* Invalid non-selected requests remain upstream's responsibility. */ }
    if (capture && url.pathname === capture.postPath && (!body || body.stepIndex === capture.step)) {
      duplicatePosts++
      trace.role = 'duplicate-post-denied'
      json(response, { error: 'proxy_duplicate_accepted_step' }, 409)
      return
    }
    const results = body?.action?.kind === 'tool_results' ? body.action.payload?.results : undefined
    const selected = !claimed && Array.isArray(results) && results.length === 1
      && (results[0]?.toolCallId ?? results[0]?.tool_call_id) === failAfterToolId
    if (!selected) { passthrough(request, response, url, raw); return }
    claimed = true
    trace.role = 'capture-original-response'
    const submissionId = singleHeader(request, 'x-aily-step-submission-id')
    const requestSha256 = singleHeader(request, 'x-aily-step-request-sha256')
    requireValue(Number.isSafeInteger(body.stepIndex) && body.stepIndex > 0 && Number.isSafeInteger(body.stepIndex + 1)
      && typeof body.lease === 'string' && body.lease.length > 0
      && singleHeader(request, 'x-aily-step-submission-version') === '1' && UUID.test(submissionId ?? '')
      && SHA256.test(requestSha256 ?? '') && requestSha256 === sha(raw), 'proxy_invalid_original_submission')
    const step = body.stepIndex, interactionId = match[1], operationId = `${interactionId}:${step}`
    capture = { ready: false, interactionId, step, operationId, submissionId, requestSha256,
      originalLeaseSha256: sha(body.lease), acceptedToolCallId: failAfterToolId,
      postPath: url.pathname, statePath: `${url.pathname.slice(0, -6)}/operations/${step}/state`,
      eventsPath: `${url.pathname.slice(0, -6)}/operations/${step}/events`, stateReads: 0, eventReads: 0 }
    const reply = await captureResponse(request, url, raw)
    Object.assign(capture, verifySse(reply, capture), { ready: true, reply })
    requireValue(response.headersSent === false, 'proxy_downstream_headers_already_sent')
    dropped++
    request.socket.destroy()
  }
  const server = http.createServer((request, response) => {
    void handle(request, response).catch(error => {
      const code = typeof error?.code === 'string' && error.code.startsWith('proxy_') ? error.code : 'proxy_protocol_failed'
      failures.push({ code, method: request.method, path: new URL(request.url, 'http://127.0.0.1').pathname })
      if (!response.headersSent && !response.destroyed) json(response, { error: code }, 409)
      else response.destroy()
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => ({ faultInjected: dropped === 1, droppedResponses: dropped, duplicatePosts,
      forwardedRequests: forwarded, requests: structuredClone(requests), failures: structuredClone(failures),
      ...(capture ? { operation: { ready: capture.ready, interactionId: capture.interactionId,
        operationId: capture.operationId, step: capture.step, acceptedToolCallId: capture.acceptedToolCallId,
        submissionId: capture.submissionId, requestSha256: capture.requestSha256,
        originalLeaseSha256: capture.originalLeaseSha256, stateReads: capture.stateReads,
        eventReads: capture.eventReads, capturedResponseBytes: capture.reply?.body.length ?? 0 } } : {}) }),
    async close() {
      for (const upstream of activeUpstreams) upstream.destroy()
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closed
    } }
}
