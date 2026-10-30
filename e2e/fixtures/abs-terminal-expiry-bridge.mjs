import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'

const sha = value => createHash('sha256').update(value).digest('hex')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Real local HTTP/SSE with deterministic model output. All tools run in the
 * actual SDK, never in this bridge. Only the final, no-tool operation loses its
 * turn_end: its prior frames arrive with real headers, then its event log is
 * already gone on the first reconnect. Durable terminal/result observations
 * must not dispatch a second model or replay any earlier tool.
 *
 * This is deliberately not the Services CAS/ledger. Usage is synthetic and no
 * credentials, tool-result bodies or program source enter snapshot evidence.
 */
export async function createAbsTerminalExpiryBridge({ interactionId, nextTool, mode = 'available', resultFault, unsettledTool }) {
  assert.match(interactionId, /^[a-zA-Z0-9_-]{1,128}$/)
  assert.equal(typeof nextTool, 'function')
  assert.ok(['available', 'missing', 'incomplete'].includes(mode))
  assert.ok(resultFault === undefined || ['operation', 'hash', 'generation'].includes(resultFault))
  assert.ok(resultFault === undefined || mode === 'available')
  assert.ok(unsettledTool === undefined || (mode === 'available' && typeof unsettledTool.id === 'string'
    && typeof unsettledTool.name === 'string' && typeof unsettledTool.arguments === 'object'))
  const operations = new Map(), requests = [], failures = []
  const finalText = 'Isolated ABS read, write and edit completed exactly once. Validation, application, reopen and C3 compilation passed. Final response recovered without replay.'
  const prefix = finalText.slice(0, 72), base = `/api/v3/interactions/${interactionId}`
  const operation = step => `${interactionId}:${step}`
  const lease = step => `isolated-terminal-lease-${step}`
  const frame = (step, seq, type, extra = {}) => ({ type, interactionId, operationId: operation(step),
    operationStepIndex: step, stepIndex: step, seq, sequence: seq, ...extra })
  let createCount = 0, expiredStep, dispatchIdentity, interruptCount = 0
  const model = async (step, result) => {
    assert.ok(!operations.has(step), 'An accepted model step must not run twice')
    const tool = await nextTool({ step, previousResult: result })
    const frames = [frame(step, 1, 'turn_begin')]
    if (tool) frames.push(frame(step, 2, 'tool_call_begin', { toolCallId: tool.id, toolName: tool.name, input: tool.arguments }),
      frame(step, 3, 'tool_call_end', { toolCallId: tool.id }))
    else {
      assert.equal(expiredStep, undefined, 'Only one final response exists')
      expiredStep = step
      if (unsettledTool) frames.push(frame(step, 2, 'tool_call_begin', { toolCallId: unsettledTool.id,
        toolName: unsettledTool.name, input: unsettledTool.arguments }), frame(step, 3, 'tool_call_end', { toolCallId: unsettledTool.id }))
      frames.push(frame(step, frames.length + 1, 'markdown_delta', { text: prefix }))
    }
    frames.push(frame(step, frames.length + 1, 'usage', { usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    frames.push(frame(step, frames.length + 1, 'turn_end', { stepIndex: step + 1,
      continuation: { nextStepIndex: step + 1, lease: lease(step + 1), status: tool ? 'waiting_tool_results' : 'completed',
        stopReason: tool ? 'TOOL_CALLS' : 'COMPLETED', pendingState: tool
          ? { kind: 'tool_results', toolCallIds: [tool.id] } : { kind: 'none' } } }))
    const value = { step, frames, tool, ...(tool || !unsettledTool ? {} : { unacknowledgedTool: true }),
      providerInvocations: 1, postCount: 1, stateReads: 0, eventReads: 0, resultReads: 0 }
    operations.set(step, value)
    return value
  }
  const json = (response, value, status = 200) => {
    const body = JSON.stringify(value)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
    response.end(body)
  }
  const stream = (response, value) => {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
      'x-aily-operation-id': operation(value.step), 'x-aily-operation-step': String(value.step) })
    // A clean EOF after flushed headers/frames deterministically models the
    // missing terminal event, not a different pre-header acknowledgement loss.
    const delivered = value.tool ? value.frames : value.frames.slice(0, -1)
    value.deliveredSequence = delivered.at(-1).seq
    value.turnEndLost = !value.tool
    response.end(delivered.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  }
  const identity = step => ({ version: 1, interactionId, operationId: operation(step), operationStepIndex: step,
    nextStepIndex: step + 1, status: 'completed', pendingKind: 'none' })
  const terminal = step => ({ ...identity(step), outputState: mode === 'available' ? 'available' : 'incomplete',
    responseGeneration: mode === 'available' ? 0 : null,
    ...(mode === 'available' ? { outputHash: 'sha256:' + sha(finalText), outputBytes: Buffer.byteLength(finalText) } : {}) })
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    requests.push({ method: request.method, path: url.pathname, query: url.search, receivedAt: new Date().toISOString() })
    try {
      if (request.method === 'POST') {
        let size = 0
        const chunks = []
        for await (const chunk of request) {
          size += chunk.length
          assert.ok(size <= 8 * 1024 * 1024, 'Bound fixture request bodies without logging their content')
          chunks.push(chunk)
        }
        const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw)
        if (url.pathname === '/api/v3/interactions/interrupt') {
          assert.equal(mode, 'missing', 'A trusted execution-terminal receipt must suppress abandonment interrupts')
          assert.ok(expiredStep !== undefined && dispatchIdentity)
          assert.deepEqual(Object.keys(body).sort(), ['idempotencyKey', 'threadId'])
          assert.deepEqual(body, dispatchIdentity, 'Legacy abandonment may only use the original exact dispatch identity')
          assert.equal(++interruptCount, 1, 'A legacy abandonment observation is not a retry loop')
          json(response, { status: 'completed' })
          return
        }
        if (url.pathname === '/api/v3/interactions') {
          assert.equal(++createCount, 1, 'Terminal recovery cannot create a new interaction')
          assert.equal(body.request?.request_context?.interaction_recovery, 'operation_stream_v1')
          if (typeof body.threadId === 'string' && body.threadId && typeof body.idempotencyKey === 'string' && body.idempotencyKey)
            dispatchIdentity = { threadId: body.threadId, idempotencyKey: body.idempotencyKey }
          stream(response, await model(0))
          return
        }
        assert.equal(url.pathname, `${base}/steps`, 'No resume/restart/redispatch route is available')
        const step = body.stepIndex, previous = operations.get(step - 1)
        assert.ok(Number.isSafeInteger(step) && step > 0 && step < 48)
        assert.equal(body.lease, lease(step))
        assert.equal(body.action?.kind, 'tool_results')
        assert.ok(previous?.tool, 'A completed no-tool operation cannot accept another step')
        const results = body.action.payload?.results
        assert.ok(Array.isArray(results) && results.length === 1)
        const result = results[0]
        assert.equal(result.toolCallId ?? result.tool_call_id, previous.tool.id)
        assert.notEqual(result.isError, true, 'Only actual successful tool results enter this fixture')
        assert.equal(request.headers['x-aily-step-submission-version'], '1')
        assert.match(request.headers['x-aily-step-submission-id'] ?? '', uuid)
        assert.equal(request.headers['x-aily-step-request-sha256'], sha(raw))
        if (operations.has(step)) {
          operations.get(step).postCount++
          throw new Error('Duplicate step POST must not execute a second model or tool')
        }
        const value = await model(step, result)
        value.acceptedToolCallId = previous.tool.id
        value.acceptedToolResultSha256 = sha(JSON.stringify(result))
        stream(response, value)
        return
      }
      assert.equal(request.method, 'GET')
      const match = url.pathname.match(new RegExp(`^${base}/operations/(\\d+)/(events|state|result)$`))
      assert.ok(match, 'Recovery is restricted to read-only observations of the same operation')
      const step = Number(match[1]), value = operations.get(step)
      assert.ok(value && step === expiredStep && value.turnEndLost && !value.tool)
      if (match[2] === 'events') {
        assert.equal(url.searchParams.get('after'), String(value.deliveredSequence), 'Use the actual received cursor, not a new stream')
        value.eventReads++
        json(response, { error: 'interaction_operation_expired' }, 410)
      } else if (match[2] === 'state') {
        assert.ok(value.eventReads >= 1, 'The first event reconnect must already have expired')
        value.stateReads++
        json(response, { interactionId, operationId: operation(step), operationStepIndex: step, stepIndex: step + 1,
          status: 'completed', pendingKind: 'none', lastSequence: null, streamState: 'expired',
          recovery: { reason: null, canonicalOnly: true, responseComplete: false },
          ...(mode === 'missing' ? {} : { executionTerminal: terminal(step) }) })
      } else {
        assert.equal(mode, 'available', 'Incomplete or missing receipts cannot authorize output recovery')
        assert.ok(value.stateReads >= 1, 'Read the durable terminal proof before output')
        value.resultReads++
        json(response, { ...identity(step), format: 'wire_text_utf8_v1', responseGeneration: resultFault === 'generation' ? 1 : 0,
          ...(resultFault === 'operation' ? { operationId: operation(step + 1) } : {}),
          text: finalText, hash: 'sha256:' + (resultFault === 'hash' ? '0'.repeat(64) : sha(finalText)), bytes: Buffer.byteLength(finalText) })
      }
    } catch (error) {
      failures.push({ path: url.pathname, message: error.message })
      if (!response.headersSent && !response.destroyed) json(response, { error: 'fixture_protocol_conflict' }, 409)
      else response.destroy()
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`, finalText, prefix,
    snapshot: () => ({ llmInvoked: false, localHttpSse: true, syntheticUsage: true, realServiceCasOrBilling: false,
      mode, ...(resultFault ? { resultFault } : {}), createCount, expiredStep, interruptCount,
      finalTextSha256: sha(finalText), finalTextBytes: Buffer.byteLength(finalText),
      requests: structuredClone(requests), failures: structuredClone(failures),
      operations: [...operations.values()].map(({ frames, tool, ...value }) => ({ ...value,
        toolName: tool?.name, toolCallId: tool?.id, frameCount: frames.length })) }),
    async close() {
      const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await done
    }
  }
}
