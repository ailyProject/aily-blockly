import assert from 'node:assert/strict'

// Identity-shaped fixture only; its signature is deliberately invalid for any
// real service. Never use a user token or expose this local bridge externally.
const token = [ { alg: 'HS256', typ: 'JWT' },
  { sub: JSON.stringify({ id: 'isolated-abs-step-account', user_type: 'free' }), jti: '1' } ]
  .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.test-signature'

/** Configure the actual Aily provider and RetrySession, using the normal SDK
 * session manager, tool loop, permission gate and WorkspaceHistory extensions.
 * Only model output is deterministic; transport and tool execution are real.
 */
export async function createAbsProviderSession({ mod, services, sessionManager }, { apiBase, onToolResult }) {
  assert.match(apiBase, /^http:\/\/127\.0\.0\.1:\d+$/)
  const { createAilyProviderExtension } = await mod('extensions/pi-aily-provider/extension')
  const { createDefaultAilyModel } = await mod('extensions/pi-aily-provider/model-catalog')
  const { createRetrySession } = await mod('retry/create-retry-session')
  const model = createDefaultAilyModel(apiBase)
  sessionManager.appendCustomEntry('aily.development-mode', { version: 1, mode: 'blockly', updatedAt: Date.now() })
  const provider = createAilyProviderExtension({ env: {}, apiBase,
    hostAuthClient: {
      getAccessToken: async () => ({ accessToken: token, generation: 1, apiBase }),
      refreshAccessToken: async () => { throw new Error('The local protocol fixture never refreshes real credentials') },
      logout: async () => {}
    },
    fetch: async (url, init) => {
      assert.equal(new URL(String(url)).origin, apiBase, 'No model/catalog request may leave the local fixture')
      return fetch(url, init)
    }
  }, services.contextCache, undefined, undefined,
  () => ({ root: services.workspaceBinding.root, reopenRequired: false }))
  return { model, createSession: createRetrySession, onToolResult,
    systemPrompt: 'Isolated ABS acceptance. Only execute the exact scoped tools requested by the local deterministic model. No hardware or external network.',
    extensionFactories: [provider, { name: 'isolated-aily-wire-context', factory(pi) {
      pi.on('before_provider_request', (event, context) => {
        const observation = services.contextCache.observe({ payload: event.payload, sessionId: sessionManager.getSessionId(),
          branchLeafId: sessionManager.getLeafId(), cwd: context.cwd, provider: model.provider, model: model.id })
        services.contextCache.completeWire(observation)
        return event.payload
      })
    } }]
  }
}
