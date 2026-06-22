import { createAgentSession, rebuildSessionFromTurns } from '../../session'
import { createAgentTurn } from '../../session/turns'

import type { AgentSession } from '../../session'
import type { AgentMessage } from '../../types/message'
import type { AgentRuntime } from '../AgentRuntime'
import type { EnsureRuntimeSessionInput } from './types'

/**
 * 解析或创建本次运行会话。
 * @param runtime - AgentRuntime 实例
 * @param input - 会话准备参数
 */
export const ensureRuntimeSession = async (runtime: AgentRuntime, input: EnsureRuntimeSessionInput) => {
	if (input.sessionId) {
		const existing = await runtime.sessionStore.get(input.sessionId)
		if (existing) return existing
	}

	const session = createAgentSession({
		id: input.sessionId,
		title: input.title,
		runtimeConfig: input.runtimeConfig
	})
	await runtime.sessionStore.save(session)
	return session
}

/**
 * 把本轮请求和响应消息提交回会话。
 * @param runtime - AgentRuntime 实例
 * @param session - 当前会话
 * @param messages - 本轮消息集合
 */
export const commitRuntimeTurn = async (
	runtime: AgentRuntime,
	session: AgentSession,
	messages: Array<AgentMessage>
) => {
	const requestMessage = messages.find(message => message.role === 'user')
	if (!requestMessage) {
		throw new Error('Cannot commit turn without a user request message')
	}

	const turn = createAgentTurn({ messages })
	const lastTurn = session.turns[session.turns.length - 1]
	const shouldReplacePendingTurn = !!lastTurn && !lastTurn.response && lastTurn.request.message.id === requestMessage.id
	const nextTurns = shouldReplacePendingTurn ? [...session.turns.slice(0, -1), turn] : [...session.turns, turn]
	const nextSession = rebuildSessionFromTurns(session, nextTurns)

	await runtime.sessionStore.save(nextSession)
	return nextSession
}
