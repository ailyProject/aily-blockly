import { mapUiChunkToRuntimeEvent } from './events'
import { collectRuntimeResponseMessages, commitRuntimeTurn, startAgentRuntimeRun } from './runCore'

import type { AgentMessage } from '../types/message'
import type { AgentRuntimeEvent } from './events'
import type { AgentRunInput, AgentRunResult } from './types'

/**
 * 执行一次 agent runtime 运行，并把 UI chunk 流转换成运行时事件流。
 * @param runtime - 当前 AgentRuntime 实例
 * @param input - 单次运行输入
 */
export async function* runAgentRuntime(
	runtime: {
		capabilities: unknown
		sessionStore: unknown
		registry: unknown
		promptPipeline: unknown
	},
	input: AgentRunInput
): AsyncGenerator<AgentRuntimeEvent, AgentRunResult, void> {
	const { session, userMessage, eventStream, messageStream } = await startAgentRuntimeRun(runtime as never, input)
	const responseMessagesPromise = collectRuntimeResponseMessages(messageStream)
	const reader = eventStream.getReader()

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			yield mapUiChunkToRuntimeEvent(value)
		}
	} catch (error) {
		yield {
			type: 'error',
			error,
			message: error instanceof Error ? error.message : String(error)
		}
		throw error
	}

	const responseMessages = await responseMessagesPromise
	const finalSession = await commitRuntimeTurn(runtime as never, session, [
		userMessage,
		...(responseMessages as Array<AgentMessage>)
	])

	return {
		session: finalSession,
		responseMessages
	}
}
