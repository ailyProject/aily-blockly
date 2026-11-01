import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createOnlineOperationFaultProxy } from '../../e2e/fixtures/online-operation-fault-proxy.mjs'

test('real upstream streams survive two downstream faults and duplicate steps never forward', { timeout: 10000 }, async () => {
  const interaction = 'itx_online_test', id = `${interaction}:0`
  let posts = 0, upstreamEnds = 0, stateReads = 0, eventReads = 0, sequence = 0
  const clients = new Set(), frames = []
  const frame = type => ({ type, text: type === 'thinking_delta' ? 'original upstream text' : undefined,
    interactionId: interaction, operationId: id, operationStepIndex: 0, seq: ++sequence, sequence })
  const send = event => { frames.push(event); for (const client of clients) client.write(`data: ${JSON.stringify(event)}\n\n`) }
  const upstream = http.createServer((request, response) => {
    request.resume()
    if (request.method === 'POST') {
      posts++
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
      clients.add(response); response.once('close', () => { clients.delete(response); upstreamEnds++ })
      send(frame('thinking_delta')); return
    }
    if (request.url.endsWith('/state')) {
      stateReads++; response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ interactionId: interaction, operationId: id, status: 'running', lastSequence: sequence })); return
    }
    eventReads++
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
    const after = Number(new URL(request.url, 'http://localhost').searchParams.get('after'))
    for (const event of frames) if (event.seq > after) response.write(`data: ${JSON.stringify(event)}\n\n`)
    clients.add(response); response.once('close', () => clients.delete(response))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = await createOnlineOperationFaultProxy({ upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    armNow: true, secondOnAnyProgressAfterMs: 30 })
  const readToDrop = async response => { try { await response.text() } catch { /* Expected broken transport. */ } }
  try {
    await readToDrop(await fetch(proxy.origin + '/api/v3/interactions', { method: 'POST', body: '{}' }))
    assert.equal(posts, 1); assert.equal(upstreamEnds, 0)
    const state = `${proxy.origin}/api/v3/interactions/${interaction}/operations/0/state`
    assert.equal((await (await fetch(state)).json()).status, 'running')
    const resumed = await fetch(`${proxy.origin}/api/v3/interactions/${interaction}/operations/0/events?after=1`)
    const reading = readToDrop(resumed)
    send(frame('thinking_delta'))
    await new Promise(resolve => setTimeout(resolve, 60))
    send(frame('thinking_delta'))
    await reading
    assert.equal(upstreamEnds, 0, 'Neither downstream loss cancels the original model connection')
    const stepUrl = `${proxy.origin}/api/v3/interactions/${interaction}/steps`
    const body = JSON.stringify({ stepIndex: 1 })
    const next = await fetch(stepUrl, { method: 'POST', body })
    await next.body.cancel()
    const duplicate = await fetch(stepUrl, { method: 'POST', body })
    assert.equal(duplicate.status, 409); assert.equal(posts, 2)
    const proof = proxy.snapshot()
    assert.equal(proof.faults.length, 2); assert.equal(proof.faults[1].canonicalStatus, 'running')
    assert.equal(proof.faults[1].resumedThinkingEvents, 2)
    assert.ok(stateReads >= 2); assert.equal(eventReads, 1)
    assert.equal(proof.duplicatePosts, 1); assert.equal(proof.syntheticOutput, false)
    assert.doesNotMatch(JSON.stringify(proof), /original upstream text/)
  } finally {
    await proxy.close()
    for (const response of clients) response.end()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  }
})

const hash = value => createHash('sha256').update(value).digest('hex')

async function unclaimedFixture() {
  const interactionId = 'itx_unclaimed_online', step = 1, operationId = `${interactionId}:${step}`
  const lease = 'original-private-lease', toolId = 'real-edit-call'
  const body = JSON.stringify({ stepIndex: step, lease, action: { kind: 'tool_results',
    payload: { results: [{ toolCallId: toolId, output: 'completed edit result' }] } } })
  const headers = { 'content-type': 'application/json', 'x-aily-step-submission-version': '1',
    'x-aily-step-recovery-version': '1', 'x-aily-step-submission-id': randomUUID(),
    'x-aily-step-request-sha256': hash(body) }
  const proof = { version: 1, interactionId, operationId, stepIndex: step,
    submissionId: headers['x-aily-step-submission-id'], requestSha256: hash(body),
    originalLeaseSha256: hash(lease), canonicalStateSha256: hash('exact original canonical snapshot') }
  const metrics = { stepPosts: 0, modelConnectionsClosed: 0, stateReads: 0, eventReads: 0 }
  const producers = new Set(), received = [], states = []
  const event = (at, type, rest = {}) => ({ type, interactionId, operationId,
    operationStepIndex: step, stepIndex: step, seq: at, sequence: at, ...rest })
  const stream = (response, events, end = true) => {
    response.writeHead(200, { 'content-type': 'text/event-stream',
      'x-aily-operation-id': operationId, 'x-aily-operation-step': String(step) })
    for (const item of events) response.write(`data: ${JSON.stringify(item)}\n\n`)
    if (end) response.end()
  }
  const frames = [event(1, 'turn_begin'), event(2, 'thinking_delta', { text: 'actual upstream reasoning' }),
    event(3, 'markdown_delta', { text: 'actual upstream answer' }), event(4, 'turn_end')]
  const upstream = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    if (request.method === 'POST' && url.pathname === '/api/v3/interactions') {
      stream(response, [
        { ...event(1, 'turn_begin'), operationId: `${interactionId}:0`, operationStepIndex: 0, stepIndex: 0 },
        { ...event(2, 'tool_call_begin', { toolCallId: toolId, toolName: 'edit', input: {} }),
          operationId: `${interactionId}:0`, operationStepIndex: 0, stepIndex: 0 },
        { ...event(3, 'turn_end'), operationId: `${interactionId}:0`, operationStepIndex: 0, stepIndex: 1 },
      ]); return
    }
    if (request.method === 'POST' && url.pathname.endsWith('/steps')) {
      metrics.stepPosts++
      received.push({ body: raw, nonce: request.headers['x-aily-step-submission-id'],
        fence: request.headers['x-aily-step-retry-state-sha256'] })
      stream(response, frames.slice(0, 1), false)
      producers.add(response)
      response.once('close', () => { producers.delete(response); metrics.modelConnectionsClosed++ })
      return
    }
    if (url.pathname.endsWith('/state')) {
      metrics.stateReads++
      const state = metrics.stepPosts === 0
        ? { interactionId, operationId, operationStepIndex: step, stepIndex: step,
            status: 'waiting_tool_results', pendingKind: 'tool_results', lastSequence: null,
            streamState: 'unknown', stepSubmissionRecovery: { ...proof, disposition: 'not_claimed' } }
        : { interactionId, operationId, operationStepIndex: step, stepIndex: step,
            status: 'running', pendingKind: 'none', lastSequence: 1, streamState: 'open',
            stepSubmission: { ...proof, canonicalStateSha256: undefined, accepted: true },
            stepSubmissionRecovery: { ...proof, disposition: 'started' } }
      states.push(JSON.parse(JSON.stringify(state)))
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(state)); return
    }
    metrics.eventReads++
    stream(response, frames)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = await createOnlineOperationFaultProxy({ upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    mode: 'unclaimed-retry-ack', armAfterToolNames: ['edit', 'write'] })
  const stepsUrl = `${proxy.origin}/api/v3/interactions/${interactionId}/steps`
  const stateUrl = `${proxy.origin}/api/v3/interactions/${interactionId}/operations/${step}/state`
  await (await fetch(proxy.origin + '/api/v3/interactions', { method: 'POST', body: '{}' })).text()
  return { proxy, metrics, body, headers, proof, received, states, stepsUrl, stateUrl,
    async close() {
      await proxy.close()
      for (const response of producers) response.end()
      upstream.closeAllConnections()
      await new Promise(resolve => upstream.close(resolve))
    } }
}

test('unreceived real step is not forwarded; exact protected retry loses ACK without cancelling upstream', { timeout: 10000 }, async () => {
  const value = await unclaimedFixture()
  try {
    await assert.rejects(fetch(value.stepsUrl, { method: 'POST', headers: value.headers, body: value.body }))
    assert.equal(value.metrics.stepPosts, 0)
    const state = await (await fetch(value.stateUrl, { headers: value.headers })).json()
    assert.deepEqual(state, value.states[0], 'Canonical state bytes are supplied by upstream, never invented by proxy')
    const retryHeaders = { ...value.headers, 'x-aily-step-retry-state-sha256': state.stepSubmissionRecovery.canonicalStateSha256 }
    await assert.rejects(fetch(value.stepsUrl, { method: 'POST', headers: retryHeaders, body: value.body }))
    assert.equal(value.metrics.stepPosts, 1)
    assert.equal(value.metrics.modelConnectionsClosed, 0, 'Lost downstream ACK leaves the accepted upstream producer running')
    const accepted = await (await fetch(value.stateUrl, { headers: retryHeaders })).json()
    assert.deepEqual(accepted, value.states[1])
    const replay = await (await fetch(value.stateUrl.replace('/state', '/events?after=0'), { headers: retryHeaders })).text()
    assert.match(replay, /actual upstream answer/)
    assert.deepEqual(value.received, [{ body: value.body,
      nonce: value.headers['x-aily-step-submission-id'], fence: value.proof.canonicalStateSha256 }])
    const evidence = value.proxy.snapshot()
    assert.equal(evidence.unclaimedRecoveryCovered, true)
    assert.equal(evidence.secondDisconnectCovered, false)
    assert.equal(evidence.duplicatePosts, 0)
    assert.equal(evidence.interruptCount, 0)
    assert.deepEqual(evidence.failures, [])
    assert.deepEqual(evidence.faults.map(item => item.kind), ['unreceived-step-disconnect', 'accepted-retry-ack-disconnect'])
    const selected = evidence.operations.find(item => item.step === 1)
    assert.equal(selected.posts, 2); assert.equal(selected.forwardedPosts, 1)
    assert.equal(selected.eventReads, 1)
    assert.doesNotMatch(JSON.stringify(evidence), /original-private-lease|completed edit result|actual upstream answer|actual upstream reasoning/)
    assert.equal(JSON.stringify(evidence).includes(value.headers['x-aily-step-submission-id']), false)
  } finally { await value.close() }
})

for (const change of ['without-observation', 'different-body', 'different-nonce', 'different-fence', 'third-post']) {
  test(`unclaimed proxy refuses ${change} without forwarding an unauthorized retry`, { timeout: 10000 }, async () => {
    const value = await unclaimedFixture()
    try {
      await assert.rejects(fetch(value.stepsUrl, { method: 'POST', headers: value.headers, body: value.body }))
      if (change !== 'without-observation') await (await fetch(value.stateUrl)).text()
      const headers = { ...value.headers, 'x-aily-step-retry-state-sha256': value.proof.canonicalStateSha256 }
      let body = value.body
      if (change === 'different-body') { body += ' '; headers['x-aily-step-request-sha256'] = hash(body) }
      if (change === 'different-nonce') headers['x-aily-step-submission-id'] = randomUUID()
      if (change === 'different-fence') headers['x-aily-step-retry-state-sha256'] = hash('another state')
      if (change === 'third-post')
        await assert.rejects(fetch(value.stepsUrl, { method: 'POST', headers, body }))
      const denied = await fetch(value.stepsUrl, { method: 'POST', headers, body })
      assert.equal(denied.status, 409)
      assert.equal(value.metrics.stepPosts, change === 'third-post' ? 1 : 0)
      assert.equal(value.proxy.snapshot().duplicatePosts, 1)
    } finally { await value.close() }
  })
}
