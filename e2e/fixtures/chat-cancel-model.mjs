import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'

const sha = value => createHash('sha256').update(value).digest('hex')

/** A local model stream that remains in thinking until the actual provider
 * cancellation endpoint receives its original create identity. No tool call,
 * tool result, completion receipt or startup proof is manufactured here. */
export async function createChatCancelModel() {
  const interactionId = 'cancel_' + randomUUID().replaceAll('-', '')
  const operationId = interactionId + ':0', base = `/api/v3/interactions/${interactionId}/operations/0`
  const requests = [], failures = [], open = new Set()
  let identity, createCount = 0, interruptCount = 0, active = false, streamClosed = false, lastSequence = 0
  const json = (response, value, status = 200) => {
    const body = JSON.stringify(value)
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body) }); response.end(body)
  }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const entry = { method: request.method, path: url.pathname, at: Date.now() }; requests.push(entry)
    try {
      if (request.method === 'POST') {
        const chunks = []; let bytes = 0
        for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 4 * 1024 * 1024); chunks.push(chunk) }
        const raw = Buffer.concat(chunks), body = JSON.parse(raw.toString('utf8'))
        if (url.pathname === '/api/v3/interactions') {
          assert.equal(++createCount, 1, 'Only one logical model submission per isolated case')
          assert.equal(body.request?.request_context?.interaction_recovery, 'operation_stream_v1')
          assert.ok(typeof body.threadId === 'string' && body.threadId && typeof body.idempotencyKey === 'string' && body.idempotencyKey)
          assert.equal(request.headers['x-aily-create-request-sha256'], sha(raw))
          identity = { threadId: body.threadId, idempotencyKey: body.idempotencyKey }; active = true
          entry.bodySha256 = sha(raw); entry.bodyBytes = raw.length
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
            'x-aily-operation-id': operationId, 'x-aily-operation-step': '0' })
          const frame = (seq, type, fields = {}) => ({ type, seq, sequence: seq, interactionId, operationId,
            operationStepIndex: 0, stepIndex: 0, ...fields })
          response.write(`data: ${JSON.stringify(frame(1, 'turn_begin'))}\n\n`)
          response.write(`data: ${JSON.stringify(frame(2, 'thinking_delta', { text: 'Controlled local thinking; waiting for the user cancellation.' }))}\n\n`)
          lastSequence = 2
          const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': local thinking keepalive\n\n') }, 250)
          const owner = { response, heartbeat }; open.add(owner)
          response.once('close', () => { clearInterval(heartbeat); open.delete(owner); streamClosed = true })
          return
        }
        assert.equal(url.pathname, '/api/v3/interactions/interrupt', 'No tool, resume or next-step route is available')
        assert.deepEqual(Object.keys(body).sort(), ['idempotencyKey', 'threadId'])
        assert.deepEqual(body, identity, 'Cancellation must address the original exact create identity')
        assert.equal(++interruptCount, 1, 'The SDK owns one cancellation, with no explicit second cleanup request')
        active = false
        json(response, { status: 'interrupted' })
        for (const item of open) { clearInterval(item.heartbeat); item.response.end() }
        return
      }
      assert.equal(request.method, 'GET')
      assert.equal(url.pathname, base + '/state', 'Only read-only canonical observation is available')
      json(response, { interactionId, operationId, operationStepIndex: 0, stepIndex: 0,
        status: active ? 'running' : 'interrupted', pendingKind: 'none', lastSequence,
        streamState: active ? 'open' : 'terminal', recovery: { reason: null, canonicalOnly: true, responseComplete: false } })
    } catch (error) {
      failures.push({ path: url.pathname, message: error.message })
      if (!response.headersSent) json(response, { error: 'isolated_cancel_fixture_conflict' }, 409)
      else response.destroy()
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => ({ localHttpSse: true, liveModel: false, serviceCasOrBilling: false,
      createCount, interruptCount, active, streamClosed, lastSequence, toolCalls: 0,
      originalIdentityCancelled: interruptCount === 1, requests: structuredClone(requests), failures: structuredClone(failures) }),
    async close() {
      for (const item of open) { clearInterval(item.heartbeat); item.response.destroy() }
      const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections(); await done
    } }
}
