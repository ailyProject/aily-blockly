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

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) await pause(5)
  assert.equal(predicate(), true, 'Expected proxy observation did not arrive')
}

async function strictThinkingFixture({ status = 'running', streamState = 'open', stateDelayMs = 0,
  canonicalSequenceLag = false, stateStatus = 200, stateReplies = [], requireResumedThinkingSpan = true } = {}) {
  const interactionId = 'itx_strict_thinking', operationId = `${interactionId}:0`, threshold = 35
  const clients = new Set(), frames = [], readings = []
  const metrics = { posts: 0, stateReads: 0, eventReads: 0, producerCloses: 0 }
  let sequence = 0
  const emit = (type, rest = {}) => {
    const event = { type, interactionId, operationId, operationStepIndex: 0,
      seq: ++sequence, ...rest }
    sequence = Math.max(sequence, event.seq)
    frames.push(event)
    for (const client of clients) client.write(`data: ${JSON.stringify(event)}\n\n`)
    return event
  }
  const upstream = http.createServer(async (request, response) => {
    request.resume()
    const url = new URL(request.url, 'http://localhost')
    if (request.method === 'POST') {
      metrics.posts++
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
      clients.add(response)
      response.once('close', () => { clients.delete(response); metrics.producerCloses++ })
      emit('thinking_delta', { text: 'private initial thinking' }); return
    }
    if (url.pathname.endsWith('/state')) {
      metrics.stateReads++
      const planned = stateReplies.shift() ?? {}
      if (planned.wait) await planned.wait
      if (stateDelayMs) await pause(stateDelayMs)
      response.writeHead(stateStatus, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ interactionId, operationId, status, streamState,
        lastSequence: planned.lastSequence ?? (canonicalSequenceLag ? 1 : sequence) })); return
    }
    metrics.eventReads++
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
    const after = Number(url.searchParams.get('after'))
    for (const event of frames) if (event.seq > after) response.write(`data: ${JSON.stringify(event)}\n\n`)
    clients.add(response); response.once('close', () => clients.delete(response))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = await createOnlineOperationFaultProxy({ upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    mode: 'live-disconnect', armNow: true, requireResumedThinkingSpan, secondOnThinkingSpanAfterMs: threshold,
    secondOnAnyProgressAfterMs: 0 })
  const consume = async response => { try { await (await response).text() } catch { /* Faults are intentional. */ } }
  await consume(fetch(proxy.origin + '/api/v3/interactions', { method: 'POST', body: '{}' }))
  assert.equal(proxy.snapshot().faults.length, 1)
  const stateUrl = `${proxy.origin}/api/v3/interactions/${interactionId}/operations/0/state`
  const readState = async () => (await fetch(stateUrl)).json()
  const resume = async (after = 1) => {
    const response = await fetch(stateUrl.replace('/state', `/events?after=${after}`))
    const reading = consume(Promise.resolve(response)); readings.push(reading)
    return reading
  }
  const freshSequence = () => proxy.snapshot().operations.find(item => item.step === 0).maxResumedSequence
  return { proxy, metrics, emit, threshold, readState, resume, freshSequence,
    async close() {
      await proxy.close()
      for (const client of clients) client.end()
      upstream.closeAllConnections()
      await new Promise(resolve => upstream.close(resolve))
      await Promise.all(readings)
    } }
}

test('strict thinking proof drops only after fresh same-operation thinking spans the threshold', { timeout: 10000 }, async () => {
  const f = await strictThinkingFixture()
  try {
    await f.readState()
    const resumed = f.resume()
    await eventually(() => f.metrics.eventReads === 1)
    const first = f.emit('thinking_delta', { text: 'private first resumed thinking' })
    await eventually(() => f.freshSequence() === first.seq)
    await pause(f.threshold + 25)
    const last = f.emit('thinking_delta', { text: 'private last resumed thinking' })
    await resumed
    const proof = f.proxy.snapshot(), fault = proof.faults[1]
    assert.equal(proof.requireResumedThinkingSpan, true)
    assert.equal(proof.secondDisconnectCovered, true)
    assert.equal(proof.strictThinkingCovered, true)
    assert.equal(fault.kind, 'second-live-disconnect')
    assert.equal(fault.strictThinking, true)
    assert.equal(fault.watermark, 1)
    assert.equal(fault.watermarkSource, 'canonical-state')
    assert.equal(fault.firstThinkingSequence, first.seq)
    assert.equal(fault.lastThinkingSequence, last.seq)
    assert.equal(fault.sequence, last.seq)
    assert.equal(fault.resumedThinkingEvents, 2)
    assert.equal(fault.resumedThinkingDurationMs, fault.lastThinkingAt - fault.firstThinkingAt)
    assert.ok(fault.resumedThinkingDurationMs > f.threshold)
    assert.equal(fault.canonicalStatus, 'running'); assert.equal(fault.canonicalStreamState, 'open')
    assert.ok(fault.canonicalSequence >= last.seq)
    assert.equal(f.metrics.posts, 1); assert.equal(f.metrics.producerCloses, 0)
    assert.equal(proof.duplicatePosts, 0); assert.deepEqual(proof.failures, [])
    assert.doesNotMatch(JSON.stringify(proof), /private.*thinking/)
  } finally { await f.close() }
})

test('strict thinking proof ignores wall time, markdown, heartbeat and empty thinking', { timeout: 10000 }, async () => {
  const f = await strictThinkingFixture()
  try {
    await f.readState(); void f.resume()
    await eventually(() => f.metrics.eventReads === 1)
    const first = f.emit('thinking_delta', { text: 'one genuine resumed event' })
    await eventually(() => f.freshSequence() === first.seq)
    await pause(f.threshold + 25)
    assert.equal(f.proxy.snapshot().faults.length, 1, 'Waiting alone cannot prove thinking')
    f.emit('markdown_delta', { text: 'real markdown is not thinking' })
    f.emit('heartbeat')
    const empty = f.emit('thinking_delta', { text: ' \t\n' })
    await eventually(() => f.freshSequence() === empty.seq)
    await pause(10)
    assert.equal(f.proxy.snapshot().faults.length, 1)
    assert.equal(f.metrics.stateReads, 1, 'No canonical fault check is attempted without strict thinking proof')
  } finally { await f.close() }
})

test('strict thinking proof rejects duplicate, decreasing and cross-operation sequences', { timeout: 10000 }, async () => {
  const f = await strictThinkingFixture()
  try {
    await f.readState(); void f.resume()
    await eventually(() => f.metrics.eventReads === 1)
    const first = f.emit('thinking_delta', { text: 'one fresh event' })
    await eventually(() => f.freshSequence() === first.seq)
    await pause(f.threshold + 25)
    f.emit('thinking_delta', { seq: first.seq, text: 'duplicate cannot extend measured thinking' })
    f.emit('thinking_delta', { seq: 1, text: 'old cached thinking cannot extend measured thinking' })
    f.emit('thinking_delta', { operationId: 'itx_other:0', interactionId: 'itx_other', text: 'foreign thinking' })
    f.emit('thinking_delta', { operationId: 'itx_strict_thinking:1', operationStepIndex: 1, text: 'another step' })
    const high = f.emit('heartbeat')
    await eventually(() => f.freshSequence() === high.seq)
    f.emit('thinking_delta', { seq: high.seq - 1, text: 'decreasing sequence' })
    await pause(15)
    assert.equal(f.proxy.snapshot().faults.length, 1)
    assert.equal(f.metrics.stateReads, 1)
  } finally { await f.close() }
})

test('strict thinking proof excludes canonical-cache replay and duplicated observation streams', { timeout: 10000 }, async () => {
  const f = await strictThinkingFixture()
  try {
    f.emit('thinking_delta', { text: 'cached thinking before canonical watermark' })
    const cached = f.emit('thinking_delta', { text: 'more cached thinking' })
    await f.readState(); void f.resume(1)
    await eventually(() => f.metrics.eventReads === 1)
    await pause(f.threshold + 25)
    f.emit('thinking_delta', { seq: cached.seq, text: 'delayed cache duplicate' })
    const first = f.emit('thinking_delta', { text: 'first genuinely fresh thinking' })
    await eventually(() => f.freshSequence() === first.seq)
    void f.resume(1)
    await eventually(() => f.metrics.eventReads === 2)
    await pause(10)
    assert.equal(f.proxy.snapshot().faults.length, 1, 'Replay and a second consumer cannot manufacture thinking duration')
    assert.equal(f.metrics.stateReads, 1)
  } finally { await f.close() }
})

for (const initialState of ['missing', 'non-200']) {
  test(`strict thinking proof cannot use an observed-stream fallback when canonical state is ${initialState}`, { timeout: 10000 }, async () => {
    const f = await strictThinkingFixture({ stateStatus: initialState === 'non-200' ? 410 : 200 })
    try {
      if (initialState === 'non-200') await f.readState()
      void f.resume()
      await eventually(() => f.metrics.eventReads === 1)
      f.emit('thinking_delta', { text: 'a real thinking event without a proven canonical baseline' })
      await pause(f.threshold + 25)
      f.emit('thinking_delta', { text: 'another real thinking event still lacks a canonical baseline' })
      await pause(15)
      const proof = f.proxy.snapshot(), operation = proof.operations.find(item => item.step === 0)
      assert.equal(proof.faults.length, 1)
      assert.equal(proof.strictThinkingCovered, false)
      assert.equal(operation.lastCanonicalSequence, undefined)
      assert.equal(operation.maxResumedSequence, 0, 'Strict evidence cannot accumulate before a successful canonical observation')
      assert.equal(f.metrics.stateReads, initialState === 'non-200' ? 1 : 0)
    } finally { await f.close() }
  })
}

test('legacy non-strict live acceptance keeps its observed-stream fallback and labels that source', { timeout: 10000 }, async () => {
  const f = await strictThinkingFixture({ requireResumedThinkingSpan: false })
  try {
    const resumed = f.resume()
    await eventually(() => f.metrics.eventReads === 1)
    f.emit('thinking_delta', { text: 'legacy progress without an initial canonical state read' })
    await resumed
    const proof = f.proxy.snapshot()
    assert.equal(proof.secondDisconnectCovered, true)
    assert.equal(proof.strictThinkingCovered, false)
    assert.equal(proof.faults[1].watermarkSource, 'observed-stream')
    assert.equal(proof.faults[1].strictThinking, false)
    assert.equal(proof.faults[1].watermark, 1)
  } finally { await f.close() }
})

test('a late older canonical response cannot lower the next resumed thinking watermark', { timeout: 10000 }, async () => {
  let releaseOlder
  const olderReply = new Promise(resolve => { releaseOlder = resolve })
  const f = await strictThinkingFixture({ stateReplies: [{ wait: olderReply, lastSequence: 1 }] })
  try {
    const slow = f.readState()
    await eventually(() => f.metrics.stateReads === 1)
    const cached = f.emit('thinking_delta', { seq: 4, text: 'progress before the fresh canonical observation' })
    const fresh = await f.readState()
    assert.equal(fresh.lastSequence, cached.seq)
    assert.equal(f.proxy.snapshot().operations.find(item => item.step === 0).lastCanonicalSequence, cached.seq)
    releaseOlder()
    assert.equal((await slow).lastSequence, 1, 'The older real upstream response is forwarded unchanged')
    assert.equal(f.proxy.snapshot().operations.find(item => item.step === 0).lastCanonicalSequence, cached.seq)
    const resumed = f.resume(1)
    await eventually(() => f.metrics.eventReads === 1)
    const first = f.emit('thinking_delta', { text: 'first thinking after the non-regressed canonical watermark' })
    await eventually(() => f.freshSequence() === first.seq)
    await pause(f.threshold + 25)
    const last = f.emit('thinking_delta', { text: 'last thinking after the non-regressed canonical watermark' })
    await resumed
    const fault = f.proxy.snapshot().faults[1]
    assert.equal(fault.watermark, cached.seq)
    assert.equal(fault.watermarkSource, 'canonical-state')
    assert.equal(fault.firstThinkingSequence, first.seq)
    assert.equal(fault.lastThinkingSequence, last.seq)
    assert.equal(fault.resumedThinkingEvents, 2)
    assert.ok(fault.resumedThinkingDurationMs > f.threshold)
  } finally { releaseOlder(); await f.close() }
})

for (const state of [
  { status: 'waiting_tool_results', streamState: 'open' },
  { status: 'running', streamState: 'done' },
  { status: 'running', streamState: 'registered' },
  { status: 'running', streamState: 'open', canonicalSequenceLag: true },
]) {
  test(`strict thinking proof requires current running/open canonical progress: ${JSON.stringify(state)}`, { timeout: 10000 }, async () => {
    const f = await strictThinkingFixture(state)
    try {
      await f.readState(); void f.resume()
      await eventually(() => f.metrics.eventReads === 1)
      const first = f.emit('thinking_delta', { text: 'first fresh thinking' })
      await eventually(() => f.freshSequence() === first.seq)
      await pause(f.threshold + 25)
      f.emit('thinking_delta', { text: 'second fresh thinking' })
      await eventually(() => f.metrics.stateReads >= 2)
      await pause(15)
      assert.equal(f.proxy.snapshot().faults.length, 1)
    } finally { await f.close() }
  })
}

test('strict thinking proof cannot disconnect an operation that terminates during canonical checking', { timeout: 10000 }, async () => {
  const f = await strictThinkingFixture({ stateDelayMs: 35 })
  try {
    await f.readState(); void f.resume()
    await eventually(() => f.metrics.eventReads === 1)
    const first = f.emit('thinking_delta', { text: 'first fresh thinking' })
    await eventually(() => f.freshSequence() === first.seq)
    await pause(f.threshold + 25)
    f.emit('thinking_delta', { text: 'second fresh thinking' })
    await eventually(() => f.metrics.stateReads >= 2)
    f.emit('turn_end')
    await pause(60)
    assert.equal(f.proxy.snapshot().faults.length, 1)
  } finally { await f.close() }
})

test('first-thinking selection skips a short operation and waits for a later natural thinking span', { timeout: 10000 }, async () => {
  const interactionId = 'itx_first_thinking_window', threshold = 80
  const clients = new Map(), sequences = new Map()
  let posts = 0, producerCloses = 0
  const emit = (step, type, rest = {}) => {
    const event = { type, interactionId, operationId: `${interactionId}:${step}`, operationStepIndex: step,
      seq: (sequences.get(step) ?? 0) + 1, ...rest }
    sequences.set(step, Math.max(sequences.get(step) ?? 0, event.seq))
    clients.get(step)?.write(`data: ${JSON.stringify(event)}\n\n`)
    return event
  }
  const upstream = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    assert.equal(request.method, 'POST')
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const step = request.url === '/api/v3/interactions' ? 0 : body.stepIndex
    posts++
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
    clients.set(step, response)
    response.once('close', () => { clients.delete(step); producerCloses++ })
    emit(step, 'thinking_delta', { text: 'private natural initial reasoning' })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = await createOnlineOperationFaultProxy({ upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    armNow: true, requireResumedThinkingSpan: true, firstDisconnectAfterThinkingMs: threshold })
  const consume = async response => { try { await response.text() } catch { /* The selected long operation is cut. */ } }
  try {
    const short = await fetch(proxy.origin + '/api/v3/interactions', { method: 'POST', body: '{}' })
    const shortReading = consume(short)
    const second = emit(0, 'thinking_delta', { text: 'short planning is still below the threshold' })
    await eventually(() => proxy.snapshot().operations.find(item => item.step === 0)?.thinkingEvents === 2)
    assert.equal(proxy.snapshot().faults.length, 0)
    assert.equal(proxy.snapshot().selectedOperation, undefined)
    await pause(threshold + 25)
    emit(0, 'thinking_delta', { seq: second.seq, text: 'a delayed duplicate is not new thinking' })
    emit(0, 'markdown_delta', { text: 'a later short-stage answer is not thinking' })
    emit(0, 'thinking_delta', { text: ' \t' })
    await pause(10)
    assert.equal(proxy.snapshot().faults.length, 0, 'Wall time, replay and answer output cannot select this short stage')
    emit(0, 'turn_end'); clients.get(0).end()
    await shortReading
    assert.equal(proxy.snapshot().selectedOperation, undefined)

    const long = await fetch(`${proxy.origin}/api/v3/interactions/${interactionId}/steps`,
      { method: 'POST', body: JSON.stringify({ stepIndex: 1 }) })
    const longReading = consume(long)
    await pause(threshold + 25)
    const last = emit(1, 'thinking_delta', { text: 'a genuinely new long-stage thinking event' })
    await longReading
    const proof = proxy.snapshot(), fault = proof.faults[0]
    assert.equal(proof.firstDisconnectAfterThinkingMs, threshold)
    assert.equal(proof.selectedOperation, `${interactionId}:1`)
    assert.equal(proof.faults.length, 1)
    assert.equal(fault.kind, 'first-thinking-disconnect')
    assert.equal(fault.originalFirstThinkingSequence, 1)
    assert.equal(fault.originalLastThinkingSequence, last.seq)
    assert.equal(fault.originalThinkingEvents, 2)
    assert.equal(fault.originalThinkingDurationMs, fault.originalLastThinkingAt - fault.originalFirstThinkingAt)
    assert.ok(fault.originalThinkingDurationMs > threshold)
    assert.equal(fault.resumedThinkingEvents, 0)
    assert.equal(fault.resumedThinkingDurationMs, 0, 'Original thinking must not inflate resumed evidence')
    assert.equal(posts, 2); assert.equal(producerCloses, 1, 'Only the naturally completed short producer has closed')
    assert.deepEqual(proof.failures, [])
    assert.doesNotMatch(JSON.stringify(proof), /private natural|short planning|delayed duplicate|long-stage thinking/)
  } finally {
    await proxy.close()
    for (const response of clients.values()) response.end()
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
