import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

const sha = value => createHash('sha256').update(value).digest('hex')
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
    void (async () => {
      const url = new URL(request.url, 'http://127.0.0.1'), chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length; assert.ok(size <= 8 * 1024 * 1024)
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks)
      let body
      try { if (raw.length) body = JSON.parse(raw.toString()) } catch { /* Real server validates. */ }
      const trace = { method: request.method, path: url.pathname, at: Date.now(), forwarded: true }
      requests.push(trace)
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
      const upstream = transport.request(new URL(url.pathname + url.search, base), { method: request.method, agent: false, ...pinned,
        headers: { ...headersFor(request.headers), host: base.host, 'accept-encoding': 'identity' } }, reply => {
        const sse = String(reply.headers['content-type'] ?? '').includes('text/event-stream')
        const decoder = new StringDecoder('utf8')
        let buffered = ''
        if (!drop || !sse || reply.statusCode !== 200) response.writeHead(reply.statusCode, headersFor(reply.headers))
        reply.on('data', chunk => {
          if (drop && sse && reply.statusCode === 200 && !dropped) {
            dropped = true
            faults.push({ kind: 'accepted-build-result-sse-disconnect', path: url.pathname, step: body.stepIndex,
              buildRequestId: capturedBuild, at: Date.now(), realUpstreamStatus: reply.statusCode })
            response.destroy()
          } else if (!dropped && !response.destroyed) response.write(chunk)
          if (!sse) return
          buffered = (buffered + decoder.write(chunk)).replaceAll('\r\n', '\n')
          if (buffered.length > 1024 * 1024) { failures.push({ code: 'sse-frame-over-limit' }); buffered = ''; return }
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
          if (drop && !dropped) failures.push({ code: 'armed-result-without-sse-frame', status: reply.statusCode })
          if (!dropped && !response.destroyed) response.end()
        })
        reply.once('error', error => { failures.push({ code: 'upstream-response', networkCode: error.code }); response.destroy() })
      })
      active.add(upstream)
      upstream.once('socket', socket => socket.once('connect', () => {
        const peer = socket.remoteAddress?.replace(/^::ffff:/, '')
        trace.upstreamAddress = peer
        if (upstreamAddress && peer !== upstreamAddress) {
          failures.push({ code: 'upstream-address-mismatch' })
          upstream.destroy(new Error('The connection did not reach the explicitly pinned test server'))
        }
      }))
      upstream.once('close', () => active.delete(upstream))
      upstream.once('error', error => { failures.push({ code: 'upstream-request', networkCode: error.code }); response.destroy() })
      // A disconnected consumer never kills an accepted upstream model operation.
      upstream.end(raw)
    })().catch(error => { failures.push({ code: 'proxy-request', name: error.name }); response.destroy() })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`,
    armAfterBuildResult() { assert.equal(faults.length, 0); assert.equal(armed, false); armed = true },
    snapshot: () => ({ transparentRealUpstream: true, syntheticOutput: false, fabricatedToolResults: false,
      ...(upstreamAddress ? { pinnedUpstreamAddress: upstreamAddress, tlsHostname: base.hostname } : {}),
      armed, capturedBuildRequestId: capturedBuild, requests: structuredClone(requests), faults: structuredClone(faults),
      failures: structuredClone(failures), operations: [...operations.values()].map(item => ({ ...item })),
      requestHashes: requests.map(item => sha(item.method + ' ' + item.path)) }),
    async close() {
      for (const request of active) request.destroy()
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections(); await closed
    } }
}
