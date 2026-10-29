import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'

const sha = value => createHash('sha256').update(value).digest('hex')
const submissionKeys = ['accepted', 'interactionId', 'operationId', 'originalLeaseSha256',
  'requestSha256', 'stepIndex', 'submissionId', 'version']
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Deterministic model stand-in over real localhost HTTP/SSE. It deliberately
 * accepts one step, records the immutable submission and its completed tool
 * result, then closes the socket BEFORE any response headers. No tool or source
 * writes occur here. The actual SDK owns every tool execution and continuation.
 * This is not the real Services CAS/ledger implementation; that is separately
 * integration-tested by Services. Never interpret these synthetic counters as
 * real model usage or billing evidence.
 */
export async function createAbsStepSubmissionBridge({ interactionId, failAfterToolId, nextTool }) {
  assert.match(interactionId, /^[a-zA-Z0-9_-]{1,128}$/)
  assert.equal(typeof nextTool, 'function')
  const operations = new Map(), requests = [], failures = []
  let droppedStep, createCount = 0
  const lease = step => `isolated-step-lease-${step}`
  const base = `/api/v3/interactions/${interactionId}`
  const operation = step => `${interactionId}:${step}`
  const frame = (step, seq, type, extra = {}) => ({ type, interactionId, operationId: operation(step),
    operationStepIndex: step, stepIndex: step, seq, sequence: seq, ...extra })
  const model = async (step, result) => {
    assert.ok(!operations.has(step), 'A second HTTP request cannot invoke the same model step again')
    const tool = await nextTool({ step, previousResult: result })
    const frames = [frame(step, 1, 'turn_begin')]
    if (tool) frames.push(frame(step, 2, 'tool_call_begin', { toolCallId: tool.id, toolName: tool.name, input: tool.arguments }),
      frame(step, 3, 'tool_call_end', { toolCallId: tool.id }))
    else frames.push(frame(step, 2, 'markdown_delta', { text: 'Isolated ABS edit, recovery, apply and compile completed.' }))
    frames.push(frame(step, frames.length + 1, 'usage', { usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    frames.push(frame(step, frames.length + 1, 'turn_end', { stepIndex: step + 1,
      continuation: { nextStepIndex: step + 1, lease: lease(step + 1), status: tool ? 'waiting_tool_results' : 'completed',
        stopReason: tool ? 'TOOL_CALLS' : 'COMPLETED', pendingState: tool
          ? { kind: 'tool_results', toolCallIds: [tool.id] } : { kind: 'none' } } }))
    const value = { step, frames, tool, providerInvocations: 1, postCount: 1, stateReads: 0, eventReads: 0 }
    operations.set(step, value)
    return value
  }
  const stream = (response, value, after = 0) => {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
      'x-aily-operation-id': operation(value.step), 'x-aily-operation-step': String(value.step) })
    response.end(value.frames.filter(event => event.seq > after).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  }
  const json = (response, value, status = 200) => {
    const body = JSON.stringify(value)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
    response.end(body)
  }
  const requireSubmission = (headers, value, observation = false) => {
    assert.equal(headers['x-aily-step-submission-version'], '1')
    assert.equal(headers['x-aily-step-submission-id'], value.submissionId)
    assert.equal(headers['x-aily-step-request-sha256'], value.requestSha256)
    if (observation) assert.equal(sha(headers['x-aily-step-original-lease'] ?? ''), value.originalLeaseSha256)
  }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    requests.push({ method: request.method, path: url.pathname, query: url.search, receivedAt: new Date().toISOString() })
    try {
      if (request.method === 'POST') {
        let size = 0
        const chunks = []
        for await (const chunk of request) {
          size += chunk.length
          assert.ok(size <= 8 * 1024 * 1024, 'Bound the fixture HTTP body without logging program text')
          chunks.push(chunk)
        }
        const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw)
        if (url.pathname === '/api/v3/interactions') {
          assert.equal(++createCount, 1, 'The fixture permits only one original user interaction')
          assert.equal(body.request?.request_context?.interaction_recovery, 'operation_stream_v1')
          stream(response, await model(0))
          return
        }
        assert.equal(url.pathname, `${base}/steps`, 'No create/resume/restart fallback is authorized')
        const step = body.stepIndex
        assert.ok(Number.isSafeInteger(step) && step > 0 && step < 32)
        assert.equal(body.lease, lease(step))
        assert.equal(body.action?.kind, 'tool_results')
        const previous = operations.get(step - 1)
        assert.ok(previous?.tool)
        const results = body.action.payload?.results
        assert.ok(Array.isArray(results) && results.length === 1)
        const result = results[0]
        assert.equal(result.toolCallId ?? result.tool_call_id, previous.tool.id)
        assert.notEqual(result.isError, true, 'Only a completed successful SDK tool result enters this acceptance')
        assert.equal(request.headers['x-aily-step-submission-version'], '1')
        assert.match(request.headers['x-aily-step-submission-id'] ?? '', uuid)
        assert.equal(request.headers['x-aily-step-request-sha256'], sha(raw))
        if (operations.has(step)) {
          operations.get(step).postCount++
          throw new Error('Duplicate POST /steps is not recovery and must never dispatch again')
        }
        const value = await model(step, result)
        Object.assign(value, { submissionId: request.headers['x-aily-step-submission-id'], requestSha256: sha(raw),
          originalLeaseSha256: sha(body.lease), acceptedToolCallId: previous.tool.id,
          acceptedToolResultSha256: sha(JSON.stringify(result)) })
        if (previous.tool.id === failAfterToolId) {
          assert.equal(droppedStep, undefined)
          droppedStep = step
          assert.equal(response.headersSent, false, 'Inject ACK loss before any headers or SSE chunks exist')
          value.headersLost = true
          request.socket.destroy()
          return
        }
        stream(response, value)
        return
      }
      assert.equal(request.method, 'GET')
      const match = url.pathname.match(new RegExp(`^${base}/operations/(\\d+)/(state|events)$`))
      assert.ok(match, 'Only authenticated same-operation observations are available')
      const step = Number(match[1]), value = operations.get(step)
      assert.ok(value && step === droppedStep && value.headersLost)
      requireSubmission(request.headers, value, true)
      if (match[2] === 'state') {
        value.stateReads++
        const receipt = { version: 1, submissionId: value.submissionId, requestSha256: value.requestSha256,
          originalLeaseSha256: value.originalLeaseSha256, stepIndex: step, operationId: operation(step),
          accepted: true, interactionId }
        assert.deepEqual(Object.keys(receipt).sort(), submissionKeys)
        json(response, { interactionId, operationId: operation(step), operationStepIndex: step, stepIndex: step + 1,
          status: value.tool ? 'waiting_tool_results' : 'completed', pendingKind: value.tool ? 'tool_results' : 'none',
          lastSequence: value.frames.length, streamState: 'terminal',
          recovery: { reason: null, canonicalOnly: true, responseComplete: false }, stepSubmission: receipt })
      } else {
        assert.ok(value.stateReads > 0, 'Read-only receipt proof must precede event subscription')
        assert.equal(url.searchParams.get('after'), '0')
        value.eventReads++
        stream(response, value, 0)
      }
    } catch (error) {
      failures.push({ path: url.pathname, message: error.message })
      if (!response.headersSent && !response.destroyed) json(response, { error: 'fixture_protocol_conflict' }, 409)
      else response.destroy()
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => ({ llmInvoked: false, localHttpSse: true, syntheticUsage: true, createCount, droppedStep,
      requests: structuredClone(requests), failures: structuredClone(failures),
      operations: [...operations.values()].map(({ frames, tool, ...value }) => ({ ...value, toolName: tool?.name,
        toolCallId: tool?.id, frameCount: frames.length })) }),
    async close() {
      const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await done
    }
  }
}
