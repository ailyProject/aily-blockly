import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createInstalledChatObserver } from '../../e2e/fixtures/installed-chat-observer.mjs'

const address = 'http://127.0.0.1:12345/ui/?token=isolated-observer-token'
const reply = (method, result = {}) => Response.json({ ok: true, method, result })
const socketError = code => Object.assign(new Error('isolated socket failure'), { code })

test('read-only session methods retry one socket failure with identical body and credentials', async () => {
  for (const method of ['session.list', 'session.read']) {
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']) {
      const requests = []
      const original = new TypeError('fetch failed', { cause: socketError(code) })
      const observe = createInstalledChatObserver(address, async (url, options) => {
        requests.push({ url: String(url), ...options })
        if (requests.length === 1) throw original
        return reply(method, { marker: 'same original session' })
      })
      assert.deepEqual(await observe(method, { sessionId: 'isolated' }), { marker: 'same original session' })
      assert.equal(requests.length, 2)
      assert.equal(requests[0].body, requests[1].body)
      assert.equal(requests[0].signal, requests[1].signal)
      for (const request of requests) {
        assert.equal(request.headers.connection, 'close')
        assert.equal(request.headers.authorization, 'Bearer isolated-observer-token')
        assert.equal(request.redirect, 'error')
        assert.equal(new URL(request.url).pathname, '/api/agent/e2e')
        assert.equal(new URL(request.url).search, '')
      }
    }
  }
})

test('commands outside the exact read-only allowlist never retry socket failures', async () => {
  for (const method of ['session.create', 'session.prompt', 'session.abort', 'tool.call', 'models.refresh', 'session.readonly']) {
    let calls = 0
    const original = socketError('ECONNRESET')
    const observe = createInstalledChatObserver(address, async () => { calls++; throw original })
    await assert.rejects(observe(method), error => error === original)
    assert.equal(calls, 1)
  }
})

test('HTTP/auth failures and invalid response data are not retried', async () => {
  for (const response of [
    ...[201, 400, 401, 403, 500, 503].map(status => new Response('{}', { status })),
    Response.json({ ok: false, method: 'session.list' }),
    Response.json({ ok: true, method: 'session.prompt' }),
    new Response('invalid JSON')
  ]) {
    let calls = 0
    const observe = createInstalledChatObserver(address, async () => { calls++; return response })
    await assert.rejects(observe('session.list'))
    assert.equal(calls, 1)
  }
  let calls = 0
  const original = new Error('ECONNRESET appears only in a data error message')
  const observe = createInstalledChatObserver(address, async () => { calls++; throw original })
  await assert.rejects(observe('session.read'), error => error === original)
  assert.equal(calls, 1)
})

test('a second socket failure preserves the first original exception and cannot submit a third time', async () => {
  const original = socketError('ECONNRESET')
  let calls = 0
  const observe = createInstalledChatObserver(address, async () => { calls++; throw calls === 1 ? original : socketError('EPIPE') })
  await assert.rejects(observe('session.read'), error => error === original)
  assert.equal(calls, 2)
})

test('retry shares one original 15s deadline without allocating a new timeout', async t => {
  const controller = new AbortController(), timeouts = [], signals = []
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return controller.signal })
  const observe = createInstalledChatObserver(address, async (_url, options) => {
    signals.push(options.signal)
    if (signals.length === 1) throw socketError('ECONNRESET')
    return reply('session.list')
  })
  await observe('session.list')
  assert.deepEqual(timeouts, [15000])
  assert.deepEqual(signals, [controller.signal, controller.signal])
})

test('deadline expiry suppresses retry and an already expired call does not dispatch', async t => {
  const controller = new AbortController()
  t.mock.method(AbortSignal, 'timeout', () => controller.signal)
  const original = socketError('ECONNRESET'), expired = new DOMException('isolated deadline expired', 'TimeoutError')
  let calls = 0
  const observe = createInstalledChatObserver(address, async () => { calls++; controller.abort(expired); throw original })
  await assert.rejects(observe('session.read'), error => error === original)
  assert.equal(calls, 1)
  await assert.rejects(observe('session.list'), error => error === expired)
  assert.equal(calls, 1)
})

test('fields cannot override method/protocol and turn a retried read into a write', async () => {
  let calls = 0
  const observe = createInstalledChatObserver(address, async () => { calls++; return reply('session.list') })
  for (const fields of [{ method: 'session.prompt' }, { protocol: 'other' }, { version: 3 }]) {
    await assert.rejects(observe('session.list', fields), /override/)
  }
  assert.equal(calls, 0)
})

test('real loopback reset retries only the read with connection close and the exact original payload', async t => {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ body: Buffer.concat(chunks).toString(), connection: request.headers.connection, url: request.url })
    if (requests.length === 1) { request.socket.destroy(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, method: 'session.read', result: { sessionId: 'original' } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const observe = createInstalledChatObserver(`http://127.0.0.1:${server.address().port}/?token=isolated`)
  assert.deepEqual(await observe('session.read', { sessionId: 'original' }), { sessionId: 'original' })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].body, requests[1].body)
  assert.ok(requests.every(request => request.connection === 'close' && !request.url.includes('token')))
})

test('a retried read still surfaces HTTP/auth/data failure without a third attempt', async () => {
  for (const response of [new Response('{}', { status: 401 }), new Response('invalid JSON'), reply('session.prompt')]) {
    let calls = 0
    const original = socketError('ECONNRESET')
    const observe = createInstalledChatObserver(address, async () => {
      if (++calls === 1) throw original
      return response
    })
    await assert.rejects(observe('session.read'), error => error !== original)
    assert.equal(calls, 2)
  }
})

test('factory rejects non-loopback, non-HTTP and URL credentials before dispatch', () => {
  for (const url of ['https://example.com/?token=isolated', 'ws://127.0.0.1/?token=isolated',
    'http://127.0.0.1.example.com/?token=isolated', 'http://user:pass@localhost/?token=isolated']) {
    assert.throws(() => createInstalledChatObserver(url), /loopback without credentials/)
  }
})

test('a real redirect is rejected without following it or moving credentials into the URL', async t => {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    request.resume()
    response.writeHead(302, { location: '/redirect-target' }); response.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const observe = createInstalledChatObserver(`http://127.0.0.1:${server.address().port}/?token=isolated`)
  await assert.rejects(observe('session.list'))
  assert.deepEqual(requests, ['/api/agent/e2e'])
})
