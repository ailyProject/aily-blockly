import { collectRuntimeResponseMessages, commitRuntimeTurn, startAgentRuntimeRun } from './runCore'

import type { AgentRuntime } from './AgentRuntime'
import type { AgentRunInput, AgentRunResult } from './types'

/**
 * 为 AgentRuntime 构建可直接输出给 API 的 UI message stream。
 * @param runtime - AgentRuntime 实例
 * @param input - 运行输入
 */
export const createAgentRunStream = async (runtime: AgentRuntime, input: AgentRunInput) => {
	const { session, userMessage, eventStream, messageStream } = await startAgentRuntimeRun(runtime, input)
	const completed = collectRuntimeResponseMessages(messageStream).then(async responseMessages => {
		const finalSession = await commitRuntimeTurn(runtime, session, [userMessage, ...responseMessages])
		return {
			session: finalSession,
			responseMessages
		} satisfies AgentRunResult
	})

	return {
		session,
		stream: eventStream,
		completed
	}
}
