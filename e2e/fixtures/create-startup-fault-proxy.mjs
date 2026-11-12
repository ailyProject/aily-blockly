import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

const sha = value => createHash('sha256').update(value).digest('hex')
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const DIGEST = /^[a-f0-9]{64}$/
const START = 'x-aily-create-startup-'
const HASH = 'x-aily-create-request-sha256'
const PROOF_KEYS = ['version', 'disposition', 'startupId', 'requestSha256', 'challenge', 'interactionId',
  'operationId', 'stepIndex', 'threadIdSha256', 'idempotencyKeySha256'].sort()
const cleanHeaders = headers => {
  const result = { ...headers }
  for (const key of ['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade']) delete result[key]
  return result
}
const hasText = event => typeof (event.text ?? event.content) === 'string' && (event.text ?? event.content).trim().length > 0
const semantic = event => ['thinking_delta', 'markdown_delta', 'text_delta'].includes(event.type) && hasText(event)
  || ['tool_call_begin', 'question_request', 'approval_request', 'response_complete'].includes(event.type)

/** Owns only test sockets. It never manufactures a service receipt, model event,
 * tool response or interruption. Original bytes and credentials stay in memory. */
export async function createStartupFaultProxy({ upstreamOrigin, mode = 'create-startup-late', createForwardAfterMs = 27500 }) {
  const base = new URL(upstreamOrigin)
  assert.ok(['http:', 'https:'].includes(base.protocol) && base.pathname === '/'
    && !base.username && !base.password && !base.search && !base.hash)
  assert.ok(['create-startup-late', 'passive'].includes(mode))
  assert.ok(Number.isFinite(createForwardAfterMs) && createForwardAfterMs >= 0)
  const transport = base.protocol === 'https:' ? https : http
  const active = new Set(), downstream = new Set(), operations = new Map(), sequences = new Map()
  const failures = [], faults = [], requests = [], challengeHashes = new Set()
  const startupProofs = { count: 0, valid: true, firstValidAt: null }
  let original, originalStart, rejectStart, timer, closing = false
  let interactionId, operationId, createRequests = 0, createForwarded = 0, createDropped = 0, createRetryForwarded = 0
  let interruptRequests = 0, stateRequests = 0, eventRequests = 0, rejectedPosts = 0
  let firstFaultAt, originalForwardedAt, originalAcceptedAt, retryForwardedAt, turnBeginAt, firstSemanticAt
  const fail = code => { failures.push({ code }); return Object.assign(new Error(code), { safeCode: code }) }
  const operation = (id, step) => {
    const key = `${id}:${step}`
    if (!operations.has(key)) {
      operations.set(key, { operationId: key, step, semanticEvents: 0, toolCalls: [], terminal: false, maxSequence: 0 })
      sequences.set(key, new Set())
    }
    return operations.get(key)
  }
  const observeEvent = event => {
    if (!event || typeof event !== 'object' || event.interactionId !== interactionId
      || !Number.isSafeInteger(event.operationStepIndex) || event.operationStepIndex < 0
      || event.operationId !== `${interactionId}:${event.operationStepIndex}`
      || !Number.isSafeInteger(event.seq) || event.seq < 1) return
    const item = operation(interactionId, event.operationStepIndex), seen = sequences.get(item.operationId)
    if (seen.has(event.seq)) return
    seen.add(event.seq); item.maxSequence = Math.max(item.maxSequence, event.seq)
    const at = Date.now()
    if (event.operationStepIndex === 0 && event.seq === 1 && event.type === 'turn_begin') turnBeginAt ??= at
    if (semantic(event)) { item.semanticEvents++; firstSemanticAt ??= at }
    if (event.type === 'tool_call_begin') item.toolCalls.push({ toolCallIdSha256: sha(String(event.toolCallId ?? '')) })
    if (event.type === 'turn_end') item.terminal = true
  }
  const observeState = (value, headers, status) => {
    const proof = value?.createStartup
    if (!proof) return
    startupProofs.count++
    const challenge = headers[START + 'challenge']
    const valid = status === 200 && original && proof && !Array.isArray(proof)
      && JSON.stringify(Object.keys(proof).sort()) === JSON.stringify(PROOF_KEYS)
      && proof.version === 1 && proof.disposition === 'started' && proof.startupId === original.startupId
      && proof.requestSha256 === original.digest && UUID.test(challenge ?? '') && proof.challenge === challenge
      && proof.interactionId === interactionId && proof.operationId === operationId && proof.stepIndex === 0
      && proof.threadIdSha256 === sha(original.threadId) && proof.idempotencyKeySha256 === sha(original.idempotencyKey)
      && value.interactionId === interactionId && value.operationId === operationId
      && value.operationStepIndex === 0 && value.stepIndex === 0 && value.status === 'running'
      && value.streamState === 'open' && value.pendingKind === 'none'
      && Number.isSafeInteger(value.lastSequence) && value.lastSequence >= 1
      && headers[START + 'version'] === '1' && headers[START + 'id'] === original.startupId
      && headers[HASH] === original.digest
    startupProofs.valid &&= Boolean(valid)
    if (valid) { startupProofs.firstValidAt ??= Date.now(); challengeHashes.add(sha(challenge)) }
    else fail('create_startup_proxy_invalid_real_proof')
  }
  const readBody = async request => {
    const chunks = []; let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 8 * 1024 * 1024) throw fail('create_startup_proxy_request_too_large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  const parseCreate = (raw, headers) => {
    let body
    try { body = JSON.parse(raw) } catch { throw fail('create_startup_proxy_invalid_create') }
    if (typeof body?.threadId !== 'string' || !body.threadId.trim()
      || typeof body.idempotencyKey !== 'string' || !body.idempotencyKey) throw fail('create_startup_proxy_missing_identity')
    const startupId = headers[START + 'id'], digest = headers[HASH]
    if (mode === 'create-startup-late' || startupId !== undefined || digest !== undefined || headers[START + 'version'] !== undefined) {
      if (headers[START + 'version'] !== '1' || !UUID.test(startupId ?? '') || !DIGEST.test(digest ?? '')
        || digest !== sha(raw) || headers[START + 'challenge'] !== undefined
        || body.request?.request_context?.interaction_recovery !== 'operation_stream_v1') throw fail('create_startup_proxy_invalid_binding')
    }
    return { raw, headers: { ...headers }, threadId: body.threadId, idempotencyKey: body.idempotencyKey, startupId, digest: sha(raw) }
  }
  const forward = (url, method, headers, raw, response, onHeaders) => {
    const upstream = transport.request(new URL(url.pathname + url.search, base), {
      method, agent: false, headers: { ...cleanHeaders(headers), host: base.host, 'accept-encoding': 'identity' },
    }, reply => {
      try { onHeaders?.(reply) } catch (error) { response?.destroy(); upstream.destroy(error); return }
      const sse = /^text\/event-stream(?:;|$)/i.test(reply.headers['content-type'] ?? '')
      const state = /\/operations\/\d+\/state$/.test(url.pathname)
      const decoder = new StringDecoder('utf8'); let buffer = '', stateSize = 0
      const stateChunks = []
      if (response && !response.destroyed) {
        response.writeHead(reply.statusCode ?? 502, cleanHeaders(reply.headers)); response.flushHeaders()
      }
      // A reader disconnect never cancels a create or invokes interrupt. Drain
      // the actual upstream immediately, including the detached original POST.
      reply.on('data', chunk => {
        if (response && !response.destroyed) response.write(chunk)
        if (sse) {
          buffer += decoder.write(chunk)
          if (buffer.length > 1024 * 1024) { buffer = ''; fail('create_startup_proxy_sse_frame_too_large'); return }
          buffer = buffer.replaceAll('\r\n', '\n')
          let end
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
            if (data) { try { observeEvent(JSON.parse(data)) } catch { /* Raw bytes still pass through. */ } }
          }
        } else if (state) {
          stateSize += chunk.length
          if (stateSize <= 65536) stateChunks.push(chunk)
        }
      })
      reply.once('end', () => {
        if (state && stateSize <= 65536) {
          try { observeState(JSON.parse(Buffer.concat(stateChunks)), headers, reply.statusCode) }
          catch { fail('create_startup_proxy_invalid_real_state') }
        }
        if (response && !response.destroyed) response.end()
      })
      reply.once('error', () => { if (!closing) fail('create_startup_proxy_response_failed'); response?.destroy() })
    })
    active.add(upstream); upstream.once('close', () => active.delete(upstream))
    upstream.once('error', error => {
      if (!closing && !error.safeCode) fail('create_startup_proxy_upstream_failed')
      onHeaders?.(undefined, error); response?.destroy()
    })
    upstream.end(raw)
    return upstream
  }
  const acceptCreate = reply => {
    const match = /^([A-Za-z0-9_-]{1,128}):0$/.exec(reply?.headers['x-aily-operation-id'] ?? '')
    if (reply?.statusCode !== 200 || !match || reply.headers['x-aily-operation-step'] !== '0'
      || !/^text\/event-stream(?:;|$)/i.test(reply.headers['content-type'] ?? '')) throw fail('create_startup_proxy_original_not_accepted')
    if (interactionId && interactionId !== match[1]) throw fail('create_startup_proxy_operation_changed')
    interactionId = match[1]; operationId = `${interactionId}:0`; operation(interactionId, 0)
  }
  const startOriginal = url => {
    if (!originalStart) {
      originalStart = new Promise((resolve, reject) => {
        rejectStart = reject
        timer = setTimeout(() => {
          timer = undefined
          if (closing) { reject(new Error('closed')); return }
          originalForwardedAt = Date.now(); createForwarded++
          forward(url, 'POST', original.headers, original.raw, undefined, (reply, error) => {
            if (error) { reject(error); return }
            try { acceptCreate(reply); originalAcceptedAt = Date.now(); resolve() }
            catch (failure) { reject(failure); throw failure }
          })
        }, Math.max(0, firstFaultAt + createForwardAfterMs - Date.now()))
      })
      originalStart.catch(() => {})
    }
    return originalStart
  }
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const create = request.method === 'POST' && url.pathname === '/api/v3/interactions'
      const raw = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await readBody(request) : undefined
      requests.push({ method: request.method, path: url.pathname, at: Date.now() })
      if (closing) { response.destroy(); return }
      if (create) {
        createRequests++
        const submitted = parseCreate(raw, request.headers)
        if (!original) original = submitted
        else if (!original.raw.equals(raw) || submitted.startupId !== original.startupId
          || submitted.headers.authorization !== original.headers.authorization) {
          rejectedPosts++; throw fail('create_startup_proxy_foreign_create')
        }
        if (mode === 'create-startup-late') {
          if (createRequests === 1) {
            firstFaultAt = Date.now(); createDropped++
            faults.push({ kind: 'original-create-unreceived', at: firstFaultAt }); response.destroy(); return
          }
          await startOriginal(url)
          if (closing) { response.destroy(); return }
          retryForwardedAt ??= Date.now(); createRetryForwarded++
        }
        createForwarded++
        forward(url, request.method, request.headers, raw, response, (reply, error) => {
          if (!error && (mode === 'create-startup-late' || reply?.statusCode === 200
            && /^([A-Za-z0-9_-]{1,128}):0$/.test(reply.headers['x-aily-operation-id'] ?? '')
            && reply.headers['x-aily-operation-step'] === '0')) acceptCreate(reply)
        })
        return
      }
      const scoped = /^\/api\/v3\/interactions\/([A-Za-z0-9_-]{1,128})(?:\/|$)/.exec(url.pathname)
      if (scoped && scoped[1] !== 'interrupt' && (!interactionId || scoped[1] !== interactionId)) {
        if (request.method === 'POST') rejectedPosts++
        throw fail('create_startup_proxy_foreign_operation')
      }
      if (request.method === 'POST' && /\/interactions(?:\/[^/]+)?\/interrupt$/.test(url.pathname)) {
        let body
        try { body = JSON.parse(raw) } catch { throw fail('create_startup_proxy_invalid_interrupt') }
        if (!original || body.threadId !== original.threadId || body.idempotencyKey !== original.idempotencyKey
          || request.headers.authorization !== original.headers.authorization) {
          rejectedPosts++; throw fail('create_startup_proxy_foreign_interrupt')
        }
        interruptRequests++
      }
      if (/\/operations\/\d+\/state$/.test(url.pathname)) stateRequests++
      if (/\/operations\/\d+\/events$/.test(url.pathname)) eventRequests++
      forward(url, request.method, request.headers, raw, response)
    })().catch(error => {
      if (closing || response.headersSent || response.destroyed) { response.destroy(); return }
      response.writeHead(error.safeCode ? 409 : 502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error.safeCode ?? 'create_startup_proxy_request_failed' }))
    })
  })
  server.on('connection', socket => { downstream.add(socket); socket.once('close', () => downstream.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => ({ mode, syntheticOutput: false, transparentRealUpstream: true, interactionId, operationId,
      selectedOperation: operationId, createForwardAfterMs, createCount: createRequests, createRequests,
      createForwarded, createDropped, createRetryForwarded, interruptCount: interruptRequests, interruptRequests,
      stateRequests, eventRequests, duplicatePosts: rejectedPosts,
      ...(original ? { bodySha256: original.digest, startupIdSha256: original.startupId ? sha(original.startupId) : null,
        threadIdSha256: sha(original.threadId), idempotencyKeySha256: sha(original.idempotencyKey) } : {}),
      firstFaultAt, originalForwardedAt, originalAcceptedAt, retryForwardedAt, turnBeginAt, firstSemanticAt,
      startupProofs: { ...startupProofs, challenges: [...challengeHashes] },
      createStartupLateCovered: mode === 'create-startup-late' && createDropped === 1 && createRetryForwarded === 1
        && startupProofs.count > 0 && startupProofs.valid && turnBeginAt < firstFaultAt + 30000
        && startupProofs.firstValidAt < firstFaultAt + 30000 && firstSemanticAt > firstFaultAt + 30000,
      operations: structuredClone([...operations.values()]), faults: structuredClone(faults),
      requests: structuredClone(requests), failures: structuredClone(failures) }),
    async close() {
      if (closing) return
      closing = true; clearTimeout(timer); rejectStart?.(new Error('closed'))
      for (const request of active) request.destroy()
      for (const socket of downstream) socket.destroy()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    } }
}
