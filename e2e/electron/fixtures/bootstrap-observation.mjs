import assert from 'node:assert/strict'
import { createInstalledChatObserver } from '../../fixtures/installed-chat-observer.mjs'

const observerTimeout = error => error?.name === 'TimeoutError' || error?.name === 'AbortError'
class BootstrapSessionReopeningError extends Error {}

/** Keep authentication and the public observer protocol unchanged. Decode only
 * exact temporary failures for an ID this read-only observer already knows. */
export function createBootstrapReadOnlyObserver(url, { fetchImpl = fetch, knownSessionIds = [], onFailure = () => {} } = {}) {
  const known = new Set(knownSessionIds)
  const observer = createInstalledChatObserver(url, async (endpoint, options) => {
    const request = JSON.parse(options.body)
    assert.ok(['session.list', 'session.read'].includes(request.method))
    const response = await fetchImpl(endpoint, options)
    let reply
    try { reply = await response.clone().json() } catch { return response }
    if (reply?.ok === false) {
      await onFailure({ at: Date.now(), method: request.method, sessionId: request.sessionId ?? null,
        status: response.status, reply })
      const id = request.sessionId
      const temporary = request.method === 'session.read' && typeof id === 'string' && known.has(id)
        && (response.status === 200 && reply.error?.code === 'SESSION_NOT_OPEN'
          && reply.error.message === 'Session is not open: ' + id
          || response.status === 500 && reply.error === 'Session ' + id + ' is closed')
      if (temporary) throw Object.assign(new BootstrapSessionReopeningError('The fixed original session is temporarily reopening'),
        { code: 'BOOTSTRAP_SESSION_REOPENING', sessionId: id, status: response.status })
    }
    if (response.status === 200 && reply?.ok === true && reply.method === request.method) {
      if (request.method === 'session.list') for (const item of reply.result?.sessions ?? []) if (typeof item.sessionId === 'string') known.add(item.sessionId)
      if (request.method === 'session.read' && reply.result?.session?.sessionId === request.sessionId) known.add(request.sessionId)
    }
    return response
  })
  return (method, fields = {}) => {
    assert.ok(['session.list', 'session.read'].includes(method), 'Bootstrap observation is strictly read-only')
    return observer(method, fields)
  }
}

/** Retry only this read-only observer operation, under its original overall
 * deadline. This never submits a prompt, tool, provider step or Host command. */
export async function readBootstrapObservation(read, { deadline, onTimeout = () => {} }) {
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw Object.assign(new Error('Bootstrap observation overall deadline expired'), { code: 'BOOTSTRAP_OBSERVATION_DEADLINE' })
    let timer
    try {
      return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Bootstrap observation overall deadline expired'),
          { code: 'BOOTSTRAP_OBSERVATION_DEADLINE' })), remaining)
      })])
    } catch (error) {
      if (!observerTimeout(error) && !(error instanceof BootstrapSessionReopeningError)) throw error
      await onTimeout({ at: Date.now(), name: error.name, code: error.code ?? null,
        ...(error.sessionId ? { sessionId: error.sessionId, status: error.status } : {}), remainingMs: Math.max(0, deadline - Date.now()) })
      if (error instanceof BootstrapSessionReopeningError) await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
    } finally { clearTimeout(timer) }
  }
}
