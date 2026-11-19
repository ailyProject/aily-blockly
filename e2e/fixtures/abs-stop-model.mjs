import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'

const sha = value => createHash('sha256').update(value).digest('hex')

/** Local deterministic output only. Real installed Chat executes all tools.
 * Supports independent user turns and original-identity interruption; it never
 * simulates a host receipt, changes a file, or contacts a model service. */
export async function createAbsStopModel({ nextTool }) {
  assert.equal(typeof nextTool, 'function')
  const interactions = new Map(), requests = [], failures = []
  let createCount = 0
  const json = (response, value, status = 200) => {
    const text = JSON.stringify(value)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    response.end(text)
  }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const entry = { method: request.method, path: url.pathname, at: Date.now() }; requests.push(entry)
    try {
      assert.equal(request.method, 'POST', 'Only deterministic create/step/interrupt routes are available')
      const chunks = []; let bytes = 0
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 8 * 1024 * 1024); chunks.push(chunk) }
      const raw = Buffer.concat(chunks), body = JSON.parse(raw.toString('utf8'))
      entry.bytes = bytes; entry.bodySha256 = sha(raw)
      if (url.pathname === '/api/v3/interactions/interrupt') {
        assert.deepEqual(Object.keys(body).sort(), ['idempotencyKey', 'threadId'])
        const matches = [...interactions.values()].filter(value => value.threadId === body.threadId && value.idempotencyKey === body.idempotencyKey)
        assert.equal(matches.length, 1, 'Interrupt must identify one exact original create')
        const state = matches[0]
        assert.equal(state.interrupted, false, 'Do not hide repeated cancellation requests')
        state.interrupted = true; state.interruptCount++
        entry.turn = state.turn; entry.originalIdentityVerified = true
        return json(response, { status: 'interrupted' })
      }
      let state, step, previousResult
      if (url.pathname === '/api/v3/interactions') {
        assert.ok(body.threadId && body.idempotencyKey)
        assert.equal([...interactions.values()].some(value => value.threadId === body.threadId && value.idempotencyKey === body.idempotencyKey), false,
          'A protective repost must not become a second synthetic model turn')
        assert.equal(request.headers['x-aily-create-request-sha256'], sha(raw))
        assert.equal(body.request?.request_context?.interaction_recovery, 'operation_stream_v1')
        const turn = createCount++, id = 'stop_boundary_' + randomUUID().replaceAll('-', '')
        state = { id, turn, threadId: body.threadId, idempotencyKey: body.idempotencyKey, nextStep: 0,
          interrupted: false, interruptCount: 0, tools: [], completed: false }
        interactions.set(id, state); step = 0
      } else {
        const id = /^\/api\/v3\/interactions\/([^/]+)\/steps$/.exec(url.pathname)?.[1]
        state = interactions.get(id); assert.ok(state, 'Step must belong to an original create')
        assert.equal(state.interrupted, false, 'Stopped turns cannot continue to another model step')
        step = body.stepIndex; assert.equal(step, state.nextStep)
        assert.equal(body.lease, `${state.id}-lease-${step}`)
        assert.equal(body.action?.kind, 'tool_results')
        assert.equal(body.action.payload?.results?.length, 1)
        previousResult = body.action.payload.results[0]
        assert.equal(previousResult.toolCallId ?? previousResult.tool_call_id, state.tools.at(-1)?.id)
        assert.equal(request.headers['x-aily-step-request-sha256'], sha(raw))
        assert.equal(request.headers['x-aily-step-submission-version'], '1')
        assert.match(request.headers['x-aily-step-submission-id'] ?? '', /^[a-f0-9-]{36}$/i)
      }
      assert.equal(state.completed, false)
      entry.turn = state.turn; entry.step = step
      const tool = await nextTool({ turn: state.turn, step, previousResult })
      const operationId = `${state.id}:${step}`
      const frame = (seq, type, extra = {}) => ({ type, seq, sequence: seq, interactionId: state.id, operationId,
        operationStepIndex: step, stepIndex: step, ...extra })
      const frames = [frame(1, 'turn_begin')]
      if (tool) {
        assert.ok(tool.id && tool.name && tool.arguments)
        state.tools.push({ id: tool.id, name: tool.name })
        frames.push(frame(2, 'tool_call_begin', { toolCallId: tool.id, toolName: tool.name, input: tool.arguments }),
          frame(3, 'tool_call_end', { toolCallId: tool.id }))
      } else { frames.push(frame(2, 'markdown_delta', { text: 'Local stop-boundary task completed.' })); state.completed = true }
      state.nextStep = step + 1
      frames.push(frame(frames.length + 1, 'usage', { usage: { prompt_tokens: 0, completion_tokens: 0 } }))
      frames.push(frame(frames.length + 1, 'turn_end', { stepIndex: state.nextStep,
        continuation: { nextStepIndex: state.nextStep, lease: `${state.id}-lease-${state.nextStep}`,
          status: tool ? 'waiting_tool_results' : 'completed', stopReason: tool ? 'TOOL_CALLS' : 'COMPLETED',
          pendingState: tool ? { kind: 'tool_results', toolCallIds: [tool.id] } : { kind: 'none' } } }))
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
        'x-aily-operation-id': operationId, 'x-aily-operation-step': String(step) })
      response.end(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''))
    } catch (error) {
      failures.push({ method: request.method, path: url.pathname, message: error.message })
      if (!response.headersSent) json(response, { error: 'local_stop_model_contract_failed' }, 409)
      else response.destroy()
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => ({ localDeterministicOutput: true, paidModelRequests: 0, createCount, requests: structuredClone(requests),
      failures: structuredClone(failures), interactions: [...interactions.values()].map(({ threadId, idempotencyKey, ...value }) => value) }),
    async close() { const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); server.closeAllConnections(); await done } }
}
