import assert from 'node:assert/strict'

const READ_ONLY = new Set(['session.list', 'session.read'])
const SOCKET_FAILURES = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'])

function socketFailure(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return false
  const seen = new Set()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    if (SOCKET_FAILURES.has(error.code)) return true
    error = error.cause
  }
  return false
}

/** Test-only product observer; model submission and tool execution use the UI. */
export function createInstalledChatObserver(url, fetchImpl = fetch) {
  const address = new URL(url)
  assert.ok(['http:', 'https:'].includes(address.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)
    && !address.username && !address.password, 'Observer URL must be loopback without credentials')
  const endpoint = new URL('/api/agent/e2e', address)
  const headers = Object.freeze({ authorization: `Bearer ${address.searchParams.get('token')}`,
    'content-type': 'application/json', connection: 'close' })
  return async (method, fields = {}) => {
    assert.ok(!['method', 'protocol', 'version'].some(key => Object.hasOwn(fields, key)),
      'Observer fields cannot override its method or protocol')
    const body = JSON.stringify({ protocol: 'aily-agent-e2e', version: 4, method, ...fields })
    // Both attempts share this original deadline, body and identity. A brief
    // observation failure never authorizes a model/tool command to run again.
    const signal = AbortSignal.timeout(15000)
    let originalError
    for (let attempt = 0; ; attempt++) {
      try {
        signal.throwIfAborted()
        const response = await fetchImpl(endpoint, { method: 'POST', headers, body, signal, redirect: 'error' })
        assert.equal(response.status, 200)
        const value = await response.json()
        signal.throwIfAborted()
        assert.equal(value.ok, true)
        assert.equal(value.method, method)
        return value.result
      } catch (error) {
        const transportFailure = socketFailure(error)
        if (attempt || !READ_ONLY.has(method) || signal.aborted || !transportFailure)
          throw attempt && transportFailure ? originalError : error
        originalError = error
      }
    }
  }
}
