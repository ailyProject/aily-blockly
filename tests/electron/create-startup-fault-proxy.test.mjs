import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createStartupFaultProxy } from '../../e2e/fixtures/create-startup-fault-proxy.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  const deadline = Date.now() + 2000
  while (!check()) { assert.ok(Date.now() < deadline, 'Test-owned observation deadline'); await pause(3) }
}
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const body = Buffer.from(JSON.stringify({ threadId: 'private-thread', idempotencyKey: 'private-idempotency',
  request: { messages: [{ role: 'user', content: 'private user prompt' }],
    request_context: { interaction_recovery: 'operation_stream_v1' } } }))
const credentials = () => ({ 'content-type': 'application/json', authorization: 'Bearer private-test-token',
  'x-aily-create-startup-version': '1', 'x-aily-create-startup-id': randomUUID(),
  'x-aily-create-request-sha256': sha(body) })
const observation = headers => ({ ...headers, 'x-aily-create-startup-challenge': randomUUID() })

async function fixture({ mode = 'create-startup-late', delay = 65, badProof = false, acceptHeaders = true,
  rejectCreateStatus } = {}) {
  const interactionId = 'itx_proxy_real', operationId = `${interactionId}:0`
  const headers = credentials(), requests = [], readers = new Set(), timers = new Set()
  let producers = 0, sequence = 0, status = 'running', interruptions = 0
  const event = (type, extra = {}) => ({ type, interactionId, operationId, operationStepIndex: 0, seq: ++sequence, ...extra })
  const begin = event('turn_begin')
  const emit = (type, extra) => {
    const value = event(type, extra)
    for (const response of readers) response.write(frame(value))
    return value
  }
  const finish = () => {
    emit('turn_end', { continuation: { status } })
    for (const response of readers) response.end()
  }
  const upstream = http.createServer((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      requests.push({ method: request.method, path: request.url, raw, headers: request.headers, at: Date.now() })
      if (request.url === '/api/v3/interactions' && request.method === 'POST') {
        if (rejectCreateStatus) {
          response.writeHead(rejectCreateStatus, { 'content-type': 'application/json', 'x-actual-denial': 'unchanged' })
          response.end('{"error":"actual-upstream-denial"}'); return
        }
        const first = producers === 0
        if (first) producers++
        const accept = () => {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'x-aily-operation-id': operationId,
            'x-aily-operation-step': acceptHeaders ? '0' : '1' }); response.flushHeaders()
          response.write(frame(begin)); readers.add(response)
          response.once('close', () => readers.delete(response))
        }
        if (first) { const timer = setTimeout(() => { timers.delete(timer); accept() }, 12); timers.add(timer) }
        else accept()
      } else if (request.url === `/api/v3/interactions/${interactionId}/operations/0/state`) {
        const proof = { version: 1, disposition: 'started', startupId: headers['x-aily-create-startup-id'],
          requestSha256: sha(body), challenge: badProof ? randomUUID() : request.headers['x-aily-create-startup-challenge'],
          interactionId, operationId, stepIndex: 0, threadIdSha256: sha('private-thread'), idempotencyKeySha256: sha('private-idempotency') }
        const value = { interactionId, operationId, operationStepIndex: 0, stepIndex: 0,
          status, streamState: status === 'running' ? 'open' : 'terminal', pendingKind: 'none', lastSequence: sequence,
          ...(request.headers['x-aily-create-startup-challenge'] ? { createStartup: proof } : {}) }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify(value))
      } else if (request.url === '/api/v3/interactions/interrupt') {
        interruptions++; status = 'interrupted'; finish()
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"actual":"upstream-interrupt"}')
      } else { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('actual upstream metadata') }
    })().catch(() => response.destroy())
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = await createStartupFaultProxy({ upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, mode,
    createForwardAfterMs: delay })
  const post = (raw = body, supplied = headers) => fetch(proxy.origin + '/api/v3/interactions', { method: 'POST', headers: supplied, body: raw })
  return { proxy, post, headers, requests, emit, finish, readers, interactionId, operationId,
    state: supplied => fetch(`${proxy.origin}/api/v3/interactions/${interactionId}/operations/0/state`, { headers: supplied }),
    metrics: () => ({ producers, interruptions }),
    async close() {
      await proxy.close()
      for (const timer of timers) clearTimeout(timer)
      for (const reader of readers) reader.end()
      upstream.closeAllConnections()
      await new Promise(resolve => upstream.close(resolve))
    } }
}

test('lost original headers delay real dispatch, then replay exact bytes only after actual acceptance', { timeout: 5000 }, async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.post())
    const first = f.proxy.snapshot()
    assert.equal(f.requests.length, 0, 'First client POST never reached the upstream')
    assert.equal(first.createDropped, 1)
    const response = await f.post()
    assert.equal(response.headers.get('x-aily-operation-id'), f.operationId)
    const text = response.text()
    await until(() => f.requests.filter(item => item.path === '/api/v3/interactions').length === 2)
    const creates = f.requests.filter(item => item.path === '/api/v3/interactions')
    assert.ok(creates[0].at >= first.firstFaultAt + 60)
    assert.ok(creates[1].at >= creates[0].at + 10, 'Replay waits for real upstream acceptance headers')
    for (const item of creates) {
      assert.deepEqual(item.raw, body)
      assert.equal(item.headers['x-aily-create-startup-id'], f.headers['x-aily-create-startup-id'])
      assert.equal(item.headers.authorization, f.headers.authorization)
    }
    const challenges = [observation(f.headers), observation(f.headers)]
    for (const supplied of challenges) {
      const state = await f.state(supplied), value = await state.json()
      assert.equal(value.createStartup.challenge, supplied['x-aily-create-startup-challenge'])
      assert.equal(state.headers.get('cache-control'), 'no-store')
    }
    // A comment-only heartbeat passes immediately and never becomes semantic progress.
    for (const reader of f.readers) reader.write(': actual upstream heartbeat\n\n')
    await pause(15)
    assert.equal(f.proxy.snapshot().firstSemanticAt, undefined)
    f.emit('thinking_delta', { text: 'private original provider thinking' })
    await until(() => f.proxy.snapshot().firstSemanticAt !== undefined)
    f.finish()
    const received = await text
    assert.ok(received.includes(': actual upstream heartbeat\n\n'))
    assert.ok(received.includes('private original provider thinking'))
    assert.equal((received.match(/private original provider thinking/g) ?? []).length, 1)
    const proof = f.proxy.snapshot()
    assert.equal(proof.createRequests, 2); assert.equal(proof.createForwarded, 2)
    assert.equal(proof.createRetryForwarded, 1); assert.equal(proof.interruptCount, 0)
    assert.equal(proof.startupProofs.count, 2); assert.equal(proof.startupProofs.valid, true)
    assert.equal(proof.startupProofs.challenges.length, 2)
    assert.ok(proof.originalAcceptedAt <= proof.retryForwardedAt)
    assert.ok(proof.turnBeginAt < proof.firstSemanticAt)
    assert.equal(proof.operations[0].semanticEvents, 1, 'Drain and replay observations deduplicate real sequence IDs')
    assert.equal(proof.operations[0].terminal, true)
    assert.deepEqual(proof.failures, [])
    assert.equal(f.metrics().producers, 1)
    const safe = JSON.stringify(proof)
    for (const secret of ['private-test-token', 'private user prompt', 'private original provider thinking',
      'private-thread', 'private-idempotency', f.headers['x-aily-create-startup-id']]) assert.ok(!safe.includes(secret))
  } finally { await f.close() }
})

test('modified request, nonce or principal never dispatches a replacement create', { timeout: 5000 }, async t => {
  for (const changed of ['body', 'nonce', 'principal']) await t.test(changed, async () => {
    const f = await fixture()
    try {
      await assert.rejects(f.post())
      const headers = { ...f.headers }
      let raw = body
      if (changed === 'body') { raw = Buffer.concat([body, Buffer.from(' ')]); headers['x-aily-create-request-sha256'] = sha(raw) }
      if (changed === 'nonce') headers['x-aily-create-startup-id'] = randomUUID()
      if (changed === 'principal') headers.authorization = 'Bearer another-private-token'
      assert.equal((await f.post(raw, headers)).status, 409)
      await pause(80)
      assert.equal(f.requests.length, 0)
      assert.equal(f.proxy.snapshot().duplicatePosts, 1)
    } finally { await f.close() }
  })
})

test('a forged upstream challenge is observed as invalid while its original bytes pass unchanged', { timeout: 5000 }, async () => {
  const f = await fixture({ mode: 'passive', badProof: true })
  try {
    const response = await f.post(), text = response.text()
    const supplied = observation(f.headers)
    const result = await (await f.state(supplied)).json()
    assert.notEqual(result.createStartup.challenge, supplied['x-aily-create-startup-challenge'])
    const proof = f.proxy.snapshot()
    assert.equal(proof.startupProofs.count, 1); assert.equal(proof.startupProofs.valid, false)
    assert.equal(proof.startupProofs.firstValidAt, null)
    assert.equal(proof.failures[0].code, 'create_startup_proxy_invalid_real_proof')
    f.finish(); await text
  } finally { await f.close() }
})

test('close cancels the held original and retry without dispatching or interrupting later', { timeout: 5000 }, async () => {
  const f = await fixture({ delay: 140 })
  try {
    await assert.rejects(f.post())
    const retry = assert.rejects(f.post())
    await until(() => f.proxy.snapshot().createRequests === 2)
    await f.proxy.close(); await retry
    await pause(180)
    assert.equal(f.requests.length, 0)
    assert.equal(f.metrics().producers, 0); assert.equal(f.metrics().interruptions, 0)
  } finally { await f.close() }
})

test('a running-looking response without the actual operation acceptance never releases retry', { timeout: 5000 }, async () => {
  const f = await fixture({ delay: 15, acceptHeaders: false })
  try {
    await assert.rejects(f.post())
    assert.equal((await f.post()).status, 409)
    assert.equal(f.requests.filter(item => item.path === '/api/v3/interactions').length, 1)
    const proof = f.proxy.snapshot()
    assert.equal(proof.createForwarded, 1)
    assert.equal(proof.createRetryForwarded, 0)
    assert.equal(proof.originalAcceptedAt, undefined)
    assert.equal(proof.startupProofs.count, 0)
    assert.equal(proof.failures[0].code, 'create_startup_proxy_original_not_accepted')
  } finally { await f.close() }
})

test('aborting the retry reader still drains original producer events without issuing interrupt', { timeout: 5000 }, async () => {
  const f = await fixture({ delay: 15 })
  try {
    await assert.rejects(f.post())
    const controller = new AbortController()
    const response = await fetch(f.proxy.origin + '/api/v3/interactions', {
      method: 'POST', headers: f.headers, body, signal: controller.signal })
    const reading = assert.rejects(response.text())
    controller.abort(); await reading
    assert.ok(f.readers.size >= 1, 'The detached original reader remains connected')
    f.emit('thinking_delta', { text: 'original continues after lost retry reader' })
    await until(() => f.proxy.snapshot().firstSemanticAt !== undefined)
    assert.equal(f.metrics().producers, 1)
    assert.equal(f.proxy.snapshot().interruptCount, 0)
    f.finish()
  } finally { await f.close() }
})

test('passive mode forwards real metadata and the original user interrupt endpoint exactly once', { timeout: 5000 }, async () => {
  const f = await fixture({ mode: 'passive' })
  try {
    assert.equal(await (await fetch(f.proxy.origin + '/api/v2/model_catalog')).text(), 'actual upstream metadata')
    const response = await f.post(), reading = response.text()
    f.emit('thinking_delta', { text: 'actual progress before user stop' })
    await until(() => f.proxy.snapshot().operations[0].semanticEvents === 1)
    const interrupt = Buffer.from('{"threadId":"private-thread","idempotencyKey":"private-idempotency"}')
    const stopped = await fetch(f.proxy.origin + '/api/v3/interactions/interrupt', { method: 'POST',
      headers: f.headers, body: interrupt })
    assert.equal(await stopped.text(), '{"actual":"upstream-interrupt"}')
    await reading
    const request = f.requests.find(item => item.path.endsWith('/interrupt'))
    assert.deepEqual(request.raw, interrupt)
    assert.equal(f.metrics().interruptions, 1)
    const state = await (await f.state({ authorization: f.headers.authorization })).json()
    assert.equal(state.status, 'interrupted')
    const proof = f.proxy.snapshot()
    assert.equal(proof.createCount, 1); assert.equal(proof.interruptCount, 1)
    assert.equal(proof.faults.length, 0); assert.deepEqual(proof.failures, [])
  } finally { await f.close() }
})

test('passive mode preserves an actual service rejection without fabricating acceptance or a transport failure', { timeout: 5000 }, async () => {
  const f = await fixture({ mode: 'passive', rejectCreateStatus: 503 })
  try {
    const response = await f.post()
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('x-actual-denial'), 'unchanged')
    assert.equal(await response.text(), '{"error":"actual-upstream-denial"}')
    const proof = f.proxy.snapshot()
    assert.equal(proof.createCount, 1)
    assert.equal(proof.interactionId, undefined)
    assert.equal(proof.startupProofs.count, 0)
    assert.equal(proof.operations.length, 0)
    assert.deepEqual(proof.failures, [])
  } finally { await f.close() }
})
