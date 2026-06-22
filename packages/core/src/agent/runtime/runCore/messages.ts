import { readUIMessageStream } from 'ai'

import type { AgentMessage } from '../../types/message'
import type { AgentUiMessageChunk } from '../events'

/**
 * 把 UI message stream 收敛成最终响应消息列表。
 * @param stream - UI 消息流
 */
export const collectRuntimeResponseMessages = async (stream: ReadableStream<AgentUiMessageChunk>) => {
	const messages: Array<AgentMessage> = []
	for await (const message of readUIMessageStream({ stream })) {
		messages.push(message as AgentMessage)
	}
	return messages
}
