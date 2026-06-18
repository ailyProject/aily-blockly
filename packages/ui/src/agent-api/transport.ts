import { resolveAgentSessionApi } from './config'

import type { AgentSessionRequest } from '@shared'
import type { AgentApi, AgentApiSendOptions, CreateAgentApiOptions } from './types'

/**
 * 创建基于 core hono API 的 agent transport。
 * @param options - 地址覆盖项
 */
export const createAgentApi = (options: CreateAgentApiOptions = {}): AgentApi => {
	const api = options.api ?? resolveAgentSessionApi(options)

	return {
		api,
		send: async (request: AgentSessionRequest, sendOptions: AgentApiSendOptions = {}) => {
			const response = await fetch(api, {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify(request),
				signal: sendOptions.signal
			})

			if (!response.ok) {
				throw new Error(`Agent API error: ${response.status}`)
			}

			return response.body
		},
		resume: async (id: string, sendOptions: AgentApiSendOptions = {}) => {
			const url = new URL(api, window.location.origin)
			url.searchParams.set('id', id)

			const response = await fetch(url, {
				method: 'GET',
				signal: sendOptions.signal
			})

			if (!response.ok) {
				throw new Error(`Agent resume error: ${response.status}`)
			}

			return response.body
		}
	}
}
