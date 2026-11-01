import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

const sha = value => createHash('sha256').update(value).digest('hex')
const DIGEST = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const semantic = event => ['thinking_delta', 'markdown_delta', 'text_delta'].includes(event.type)
  && typeof event.text === 'string' && event.text.trim().length > 0
const stripHopHeaders = headers => {
  const clean = { ...headers }
  for (const key of ['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade']) delete clean[key]
  return clean
}

/** Test-owned transparent proxy. Original model responses and canonical state
 * always come from the real upstream. Dropping a downstream never cancels its
 * upstream model stream; discarded bytes are consumed, not cached/replayed.
 * Credentials, request bodies and output text never enter snapshot(). */
export async function createOnlineOperationFaultProxy({ upstreamOrigin, armAfterToolName = 'edit',
  armAfterToolNames = [armAfterToolName], armNow = false, secondOnAnyProgressAfterMs = 32_000,
  mode = 'live-disconnect' }) {
  const base = new URL(upstreamOrigin)
  assert.ok(['http:', 'https:'].includes(base.protocol) && base.pathname === '/'
    && !base.username && !base.password && !base.search && !base.hash)
  assert.ok(Number.isFinite(secondOnAnyProgressAfterMs) && secondOnAnyProgressAfterMs >= 0)
  assert.ok(['live-disconnect', 'unclaimed-retry-ack'].includes(mode))
  assert.ok(Array.isArray(armAfterToolNames) && armAfterToolNames.length > 0
    && armAfterToolNames.every(name => typeof name === 'string' && name.length > 0))
  assert.ok(mode !== 'unclaimed-retry-ack' || !armNow, 'Unclaimed-step acceptance must follow a real completed tool')
  const transport = base.protocol === 'https:' ? https : http
  const active = new Set(), operations = new Map(), toolNames = new Map(), requests = [], faults = [], failures = []
  let interactionId, selectedOperation, armed = armNow, duplicatePosts = 0, createCount = 0, interruptCount = 0, unclaimed
  const getOperation = (id, step) => {
    const key = `${id}:${step}`
    if (!operations.has(key)) operations.set(key, { id, step, posts: 0, forwardedPosts: 0, stateReads: 0, eventReads: 0,
      maxSequence: 0, thinkingEvents: 0, semanticEvents: 0, toolCalls: [], terminal: false })
    return operations.get(key)
  }
  const open = (url, method, headers, callback) => {
    const request = transport.request(new URL(url.pathname + url.search, base), {
      method, headers: { ...stripHopHeaders(headers), host: base.host, 'accept-encoding': 'identity' },
    }, callback)
    active.add(request)
    request.once('close', () => active.delete(request))
    return request
  }
  const canonicalState = (operation, headers) => new Promise(resolve => {
    const pathname = `/api/v3/interactions/${operation.id}/operations/${operation.step}/state`
    const clean = stripHopHeaders(headers)
    delete clean['content-length']; delete clean['content-type']
    const request = open(new URL(pathname, base), 'GET', clean, reply => {
      const chunks = []; let size = 0
      reply.on('data', chunk => { size += chunk.length; if (size <= 8192) chunks.push(chunk); else reply.destroy() })
      reply.once('error', () => resolve(undefined))
      reply.once('end', () => {
        try {
          const state = JSON.parse(Buffer.concat(chunks).toString())
          resolve(reply.statusCode === 200 && size <= 8192 && state.interactionId === operation.id
            && state.operationId === `${operation.id}:${operation.step}` ? state : undefined)
        } catch { resolve(undefined) }
      })
    })
    request.setTimeout(5000, () => request.destroy())
    request.once('error', () => resolve(undefined)); request.end()
  })
  const readBody = async request => {
    const chunks = []; let size = 0
    for await (const chunk of request) {
      size += chunk.length
      assert.ok(size <= 8 * 1024 * 1024, 'online_proxy_request_too_large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  const json = (response, value, status) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  const rejectDuplicate = (response, step, code = 'online_proxy_duplicate_step') => {
    duplicatePosts++; failures.push({ code, ...(step === undefined ? {} : { step }) })
    json(response, { error: code }, 409)
  }
  const observeGrant = (state, operation) => {
    if (!unclaimed || unclaimed.operationId !== `${operation.id}:${operation.step}`) return
    const proof = state?.stepSubmissionRecovery
    if (state.interactionId !== operation.id || state.operationId !== unclaimed.operationId
      || state.operationStepIndex !== operation.step || state.stepIndex !== operation.step
      || state.status !== 'waiting_tool_results' || state.pendingKind !== 'tool_results'
      || state.lastSequence !== null || state.streamState !== 'unknown'
      || proof?.version !== 1 || proof.disposition !== 'not_claimed'
      || proof.interactionId !== operation.id || proof.operationId !== unclaimed.operationId
      || proof.stepIndex !== operation.step || proof.submissionId !== unclaimed.submissionId
      || proof.requestSha256 !== unclaimed.bodySha256 || proof.originalLeaseSha256 !== unclaimed.leaseSha256
      || !DIGEST.test(proof.canonicalStateSha256 ?? '')) return
    if (unclaimed.fence && unclaimed.fence !== proof.canonicalStateSha256) {
      failures.push({ code: 'online_proxy_grant_changed', step: operation.step }); return
    }
    unclaimed.fence = proof.canonicalStateSha256
    unclaimed.notClaimedObservations++
  }
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const create = request.method === 'POST' && url.pathname === '/api/v3/interactions'
      const stepMatch = url.pathname.match(/^\/api\/v3\/interactions\/([A-Za-z0-9_-]{1,128})\/steps$/)
      const observe = url.pathname.match(/^\/api\/v3\/interactions\/([A-Za-z0-9_-]{1,128})\/operations\/(\d+)\/(state|events|result)$/)
      const raw = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await readBody(request) : undefined
      let body
      try { if (raw) body = JSON.parse(raw.toString()) } catch { /* Upstream owns validation. */ }
      let operation
      let protectedRetry = false
      const trace = { method: request.method, path: url.pathname, at: Date.now(), forwarded: false }
      requests.push(trace)
      if (interactionId && ((stepMatch && stepMatch[1] !== interactionId) || (observe && observe[1] !== interactionId))) {
        failures.push({ code: 'online_proxy_foreign_operation' })
        json(response, { error: 'online_proxy_foreign_operation' }, 409); return
      }
      if (create && createCount++) {
        rejectDuplicate(response, undefined, 'online_proxy_duplicate_create'); return
      }
      if (stepMatch && stepMatch[1] === interactionId && Number.isSafeInteger(body?.stepIndex)) {
        operation = getOperation(interactionId, body.stepIndex)
        operation.posts++
        const results = body?.action?.kind === 'tool_results' ? body.action.payload?.results : undefined
        const completed = Array.isArray(results) && results.some(result => result.isError !== true
          && armAfterToolNames.includes(toolNames.get(result.toolCallId ?? result.tool_call_id)))
        if (completed) armed = true
        if (mode === 'unclaimed-retry-ack' && !unclaimed && completed) {
          assert.equal(operation.posts, 1)
          assert.equal(request.headers['x-aily-step-submission-version'], '1')
          assert.equal(request.headers['x-aily-step-recovery-version'], '1')
          assert.ok(UUID.test(request.headers['x-aily-step-submission-id'] ?? ''))
          assert.equal(request.headers['x-aily-step-request-sha256'], sha(raw))
          assert.equal(typeof body.lease, 'string')
          assert.equal(request.headers['x-aily-step-retry-state-sha256'], undefined)
          selectedOperation = `${operation.id}:${operation.step}`
          unclaimed = { operationId: selectedOperation, step: operation.step,
            submissionId: request.headers['x-aily-step-submission-id'], bodySha256: sha(raw),
            leaseSha256: sha(body.lease), notClaimedObservations: 0, retryForwarded: false,
            toolCallIdsSha256: results.map(result => result.toolCallId ?? result.tool_call_id)
              .filter(id => typeof id === 'string').map(sha),
            lostRetryHeaders: false }
          faults.push({ kind: 'unreceived-step-disconnect', operationId: selectedOperation,
            step: operation.step, sequence: 0, at: Date.now() })
          // Deliberately do not create an upstream request. The real service,
          // not this proxy, must decide whether this step was ever claimed.
          request.socket.destroy(); return
        }
        if (operation.posts > 1) {
          if (mode !== 'unclaimed-retry-ack' || !unclaimed || selectedOperation !== `${operation.id}:${operation.step}`
            || operation.posts !== 2 || unclaimed.retryForwarded || !unclaimed.fence
            || request.headers['x-aily-step-submission-version'] !== '1'
            || request.headers['x-aily-step-recovery-version'] !== '1'
            || request.headers['x-aily-step-submission-id'] !== unclaimed.submissionId
            || request.headers['x-aily-step-request-sha256'] !== unclaimed.bodySha256
            || sha(raw) !== unclaimed.bodySha256
            || request.headers['x-aily-step-retry-state-sha256'] !== unclaimed.fence) {
            rejectDuplicate(response, operation.step); return
          }
          protectedRetry = true
          unclaimed.retryForwarded = true
        }
      }
      if (observe && observe[1] === interactionId) {
        operation = getOperation(interactionId, Number(observe[2]))
        if (observe[3] === 'state') operation.stateReads++
        if (observe[3] === 'events') operation.eventReads++
      }
      if (interactionId && request.method === 'POST' && (url.pathname === `/api/v3/interactions/${interactionId}/interrupt`
        || url.pathname === '/api/v3/interactions/interrupt')) interruptCount++
      trace.forwarded = true
      if (stepMatch && operation) operation.forwardedPosts++
      const upstream = open(url, request.method, request.headers, reply => {
        trace.status = reply.statusCode
        const sse = reply.statusCode === 200 && /^text\/event-stream(?:;|$)/i.test(reply.headers['content-type'] ?? '')
        let awaitRetryBegin = protectedRetry && sse
          && reply.headers['x-aily-operation-id'] === unclaimed.operationId
          && reply.headers['x-aily-operation-step'] === String(operation.step)
        const pendingPrefix = []
        let pendingBytes = 0
        const forwardHeaders = () => {
          if (!response.headersSent && !response.destroyed) {
            response.writeHead(reply.statusCode ?? 502, stripHopHeaders(reply.headers)); response.flushHeaders()
          }
        }
        if (!awaitRetryBegin) forwardHeaders()
        let buffer = '', stateBody = '', dropped = false, checking = false
        const decoder = new StringDecoder('utf8')
        const resumed = observe?.[3] === 'events'
        const watermark = operation?.lastCanonicalSequence ?? operation?.maxSequence ?? 0
        let resumedLiveAt, resumedThinkingAt, resumedThinkingEvents = 0
        const drop = (kind, event, state) => {
          if (dropped || response.destroyed || faults.length >= 2) return
          dropped = true
          faults.push({ kind, operationId: `${operation.id}:${operation.step}`, step: operation.step,
            sequence: event.seq, at: Date.now(), resumedLiveDurationMs: resumedLiveAt === undefined ? 0 : Date.now() - resumedLiveAt,
            resumedThinkingDurationMs: resumedThinkingAt === undefined ? 0 : Date.now() - resumedThinkingAt,
            resumedThinkingEvents, ...(state ? { canonicalStatus: state.status, canonicalSequence: state.lastSequence } : {}) })
          response.destroy()
        }
        const onEvent = event => {
          if (!interactionId && create && typeof event.interactionId === 'string') interactionId = event.interactionId
          if (event.interactionId !== interactionId || !Number.isSafeInteger(event.operationStepIndex)
            || !Number.isSafeInteger(event.seq) || event.seq <= 0
            || event.operationId !== `${interactionId}:${event.operationStepIndex}`) return
          operation ??= getOperation(interactionId, event.operationStepIndex)
          if (operation.step !== event.operationStepIndex) return
          if (create && operation.posts === 0) { operation.posts = 1; operation.forwardedPosts = 1 }
          operation.maxSequence = Math.max(operation.maxSequence, event.seq)
          if (awaitRetryBegin && event.type === 'turn_begin' && event.seq >= 1) {
            awaitRetryBegin = false
            unclaimed.lostRetryHeaders = true
            pendingPrefix.length = 0
            drop('accepted-retry-ack-disconnect', event)
          }
          if (event.type === 'tool_call_begin' && typeof event.toolCallId === 'string') {
            const name = event.toolName === 'tool_invoke' ? event.input?.name ?? event.toolName : event.toolName
            toolNames.set(event.toolCallId, name)
            const idHash = sha(event.toolCallId)
            if (!operation.toolCalls.some(item => item.idHash === idHash)) operation.toolCalls.push({ name, idHash })
          }
          if (event.type === 'turn_end') operation.terminal = true
          if (!semantic(event)) return
          operation.semanticEvents++
          if (event.type === 'thinking_delta') operation.thinkingEvents++
          if (dropped || response.destroyed || operation.terminal) return
          if (mode !== 'live-disconnect') return
          if (!selectedOperation && armed && event.type === 'thinking_delta' && faults.length === 0) {
            selectedOperation = `${operation.id}:${operation.step}`
            drop('first-thinking-disconnect', event); return
          }
          if (!resumed || selectedOperation !== `${operation.id}:${operation.step}` || faults.length !== 1
            || event.seq <= watermark) return
          resumedLiveAt ??= Date.now()
          if (event.type === 'thinking_delta') { resumedThinkingAt ??= Date.now(); resumedThinkingEvents++ }
          if (Date.now() - resumedLiveAt < secondOnAnyProgressAfterMs || checking) return
          checking = true
          void canonicalState(operation, request.headers).then(state => {
            if (state?.status === 'running' && !operation.terminal && !response.destroyed) {
              drop('second-live-disconnect', event, state)
            }
          }).finally(() => { checking = false })
        }
        reply.on('data', chunk => {
          // Forward the untouched original bytes before any deliberate boundary.
          if (!dropped && !response.destroyed) {
            if (awaitRetryBegin) {
              pendingBytes += chunk.length
              if (pendingBytes > 64 * 1024) {
                failures.push({ code: 'online_proxy_retry_begin_missing', step: operation.step })
                awaitRetryBegin = false; forwardHeaders()
                for (const prefix of pendingPrefix) response.write(prefix)
                pendingPrefix.length = 0
                response.write(chunk)
              } else pendingPrefix.push(chunk)
            } else response.write(chunk)
          }
          if (sse) {
            buffer += decoder.write(chunk)
            if (buffer.length > 1024 * 1024) { failures.push({ code: 'online_proxy_sse_frame_too_large' }); buffer = ''; return }
            buffer = buffer.replaceAll('\r\n', '\n')
            let end
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
              const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
              if (data) try { onEvent(JSON.parse(data)) } catch { /* Observe valid events only. */ }
            }
          } else if (observe?.[3] === 'state' && stateBody.length < 8192) stateBody += chunk.toString('utf8')
        })
        reply.once('end', () => {
          if (operation && observe?.[3] === 'state') try {
            const state = JSON.parse(stateBody)
            if (state.interactionId === operation.id && state.operationId === `${operation.id}:${operation.step}`
              && Number.isSafeInteger(state.lastSequence)) operation.lastCanonicalSequence = state.lastSequence
            if (reply.statusCode === 200) observeGrant(state, operation)
          } catch { /* Real client validates the unchanged state response. */ }
          if (!dropped && !response.destroyed) {
            if (awaitRetryBegin) {
              failures.push({ code: 'online_proxy_retry_begin_missing', step: operation.step })
              forwardHeaders()
              for (const prefix of pendingPrefix) response.write(prefix)
            }
            response.end()
          }
        })
        reply.once('error', () => { if (!response.destroyed) response.destroy() })
        // Deliberately no downstream-close -> upstream.destroy propagation.
        // The original upstream is consumed until it ends; never rerun it.
      })
      upstream.once('error', error => {
        failures.push({ code: 'online_proxy_upstream_failed', networkCode: error.code, path: url.pathname })
        if (!response.destroyed) response.destroy()
      })
      upstream.end(raw)
    })().catch(() => {
      failures.push({ code: 'online_proxy_request_failed' })
      if (!response.headersSent) json(response, { error: 'online_proxy_request_failed' }, 502)
      else response.destroy()
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`,
    arm() { armed = true },
    snapshot: () => ({ mode, transparentRealUpstream: true, syntheticOutput: false, interactionId, selectedOperation,
      armed, createCount, duplicatePosts, interruptCount, faults: structuredClone(faults),
      secondDisconnectCovered: mode === 'live-disconnect' && faults.length === 2,
      unclaimedRecoveryCovered: mode === 'unclaimed-retry-ack' && unclaimed?.retryForwarded === true
        && unclaimed?.lostRetryHeaders === true && unclaimed?.notClaimedObservations > 0,
      ...(unclaimed ? { unclaimed: { operationId: unclaimed.operationId, step: unclaimed.step,
        bodySha256: unclaimed.bodySha256, submissionIdSha256: sha(unclaimed.submissionId),
        toolCallIdsSha256: [...unclaimed.toolCallIdsSha256],
        notClaimedObservations: unclaimed.notClaimedObservations, retryForwarded: unclaimed.retryForwarded,
        lostRetryHeaders: unclaimed.lostRetryHeaders } } : {}),
      requests: structuredClone(requests), failures: structuredClone(failures),
      operations: [...operations.values()].map(({ id, ...operation }) => ({ operationId: `${id}:${operation.step}`, ...operation })) }),
    async close() {
      for (const request of active) request.destroy()
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections(); await closed
    } }
}
