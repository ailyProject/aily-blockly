import { DefaultChatTransport } from 'ai'

import { resolveAgentSessionApi } from './config'

import type { AgentSessionRequest } from '@ui/workspace/shared'
import type { UIMessage } from 'ai'
import type { CreateAgentApiOptions } from './types'

const getLastUserText = (messages: UIMessage[]) => {
	const lastMessage = messages.at(-1)
	if (!lastMessage) return ''

	return lastMessage.parts
		.filter(part => part.type === 'text')
		.map(part => part.text)
		.join('')
}

/**
 * 创建基于 core hono API 的 AI SDK chat transport。
 * @param options - agent API 配置项
 */
export const createAgentChatTransport = (options: CreateAgentApiOptions = {}) =>
	new DefaultChatTransport({
		api: options.api ?? resolveAgentSessionApi(options),
		prepareSendMessagesRequest: async ({ id, messages, body, headers, credentials, api }) => {
			const text = getLastUserText(messages)
			const request = {
				id,
				text,
				...(body ?? {})
			} satisfies Partial<AgentSessionRequest> & { id: string; text: string }

			return {
				api,
				headers,
				credentials,
				body: request
			}
		},
		prepareReconnectToStreamRequest: async ({ id, headers, credentials, api }) => ({
			api: `${api}?id=${encodeURIComponent(id)}`,
			headers,
			credentials
		})
	})
