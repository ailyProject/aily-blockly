import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'

const sha = value => createHash('sha256').update(value).digest('hex')

/** A protocol fixture in front of the existing local model bridge, not the
 * production Services CAS. Drop one completed SDK tool-result request before
 * forwarding; require an exact, one-use recovery binding before forwarding it.
 * The underlying bridge then loses the accepted response headers a second time.
 * Neither fixture executes a tool, reads source files, or rewrites model output.
 */
export async function createAbsUnclaimedStepProxy({ upstreamOrigin, failAfterToolId }) {
  const upstreamBase = new URL(upstreamOrigin)
  assert.equal(upstreamBase.protocol, 'http:'); assert.equal(upstreamBase.hostname, '127.0.0.1')
  const requests = [], failures = [], upstreams = new Set()
  let pending, droppedRequests = 0, retryPosts = 0, negativeReads = 0, forwardedTargetPosts = 0
  const json = (response, value) => {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      requests.push({ method: request.method, path: url.pathname })
      let raw
      if (request.method === 'POST') {
        const chunks = []; let size = 0
        for await (const chunk of request) { size += chunk.length; assert.ok(size <= 8 * 1024 * 1024); chunks.push(chunk) }
        raw = Buffer.concat(chunks)
      }
      const body = raw ? JSON.parse(raw.toString('utf8')) : undefined
      const selected = body?.action?.kind === 'tool_results'
        && body.action.payload?.results?.some(result => (result.toolCallId ?? result.tool_call_id) === failAfterToolId)
      if (selected) {
        assert.equal(request.headers['x-aily-step-recovery-version'], '1')
        if (!pending) {
          const match = url.pathname.match(/^\/api\/v3\/interactions\/([A-Za-z0-9_-]+)\/steps$/)
          assert.ok(match && Number.isSafeInteger(body.stepIndex) && body.stepIndex > 0)
          pending = { path: url.pathname, interactionId: match[1], step: body.stepIndex, raw,
            id: request.headers['x-aily-step-submission-id'], digest: sha(raw), lease: body.lease,
            fence: sha('isolated-unclaimed-canonical:' + sha(raw)), forwarded: false }
          assert.equal(request.headers['x-aily-step-request-sha256'], pending.digest)
          assert.equal(request.headers['x-aily-step-retry-state-sha256'], undefined)
          droppedRequests++; request.socket.destroy(); return
        }
        assert.equal(pending.forwarded, false, 'Only one protected retransmission, never a second provider execution')
        assert.ok(negativeReads > 0)
        assert.equal(url.pathname, pending.path); assert.deepEqual(raw, pending.raw)
        assert.equal(request.headers['x-aily-step-submission-id'], pending.id)
        assert.equal(request.headers['x-aily-step-request-sha256'], pending.digest)
        assert.equal(request.headers['x-aily-step-retry-state-sha256'], pending.fence)
        assert.equal(body.lease, pending.lease)
        retryPosts++; pending.forwarded = true; forwardedTargetPosts++
      }
      if (pending && !pending.forwarded && request.method === 'GET'
        && url.pathname === `/api/v3/interactions/${pending.interactionId}/operations/${pending.step}/state`) {
        assert.equal(request.headers['x-aily-step-recovery-version'], '1')
        assert.equal(request.headers['x-aily-step-submission-id'], pending.id)
        assert.equal(request.headers['x-aily-step-request-sha256'], pending.digest)
        assert.equal(request.headers['x-aily-step-original-lease'], pending.lease)
        negativeReads++
        json(response, { interactionId: pending.interactionId, operationId: `${pending.interactionId}:${pending.step}`,
          operationStepIndex: pending.step, stepIndex: pending.step, status: 'waiting_tool_results',
          pendingKind: 'tool_results', lastSequence: null, streamState: 'unknown',
          recovery: { reason: null, canonicalOnly: true, responseComplete: false }, stepSubmissionRecovery: {
            version: 1, disposition: 'not_claimed', interactionId: pending.interactionId,
            operationId: `${pending.interactionId}:${pending.step}`, stepIndex: pending.step,
            submissionId: pending.id, requestSha256: pending.digest, originalLeaseSha256: sha(pending.lease),
            canonicalStateSha256: pending.fence } })
        return
      }
      const forwarded = http.request(new URL(url.pathname + url.search, upstreamBase), {
        method: request.method, headers: { ...request.headers, host: upstreamBase.host }
      }, reply => {
        response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response)
        reply.once('error', () => response.destroy())
      })
      upstreams.add(forwarded); forwarded.once('close', () => upstreams.delete(forwarded))
      forwarded.once('error', () => response.destroy())
      forwarded.end(raw)
    })().catch(error => {
      failures.push({ path: new URL(request.url, 'http://127.0.0.1').pathname, message: error.message })
      if (!response.headersSent && !response.destroyed) response.writeHead(409).end()
      else response.destroy()
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => ({ productionServicesCas: false, droppedRequests, retryPosts, negativeReads, forwardedTargetPosts,
      originalBodyUnchanged: retryPosts === 1, requests: structuredClone(requests), failures: structuredClone(failures) }),
    async close() {
      for (const request of upstreams) request.destroy()
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections(); await closed
    } }
}
