import { createAgentSession } from '../session'

import type { AgentSession, AgentSessionStore, CreateAgentSessionInput } from '../session'

/**
 * 创建并持久化新会话。
 * @param sessionStore - 会话存储
 * @param input - 新会话输入
 */
export const createRuntimeSession = async (sessionStore: AgentSessionStore, input: CreateAgentSessionInput) => {
	const session = createAgentSession(input)
	await sessionStore.save(session)
	return session
}

/**
 * 读取运行时会话。
 * @param sessionStore - 会话存储
 * @param sessionId - 会话 ID
 */
export const getRuntimeSession = (sessionStore: AgentSessionStore, sessionId: string) => sessionStore.get(sessionId)

/**
 * 保存运行时会话。
 * @param sessionStore - 会话存储
 * @param session - 目标会话
 */
export const saveRuntimeSession = async (sessionStore: AgentSessionStore, session: AgentSession) => {
	await sessionStore.save(session)
	return session
}

export const updateRuntimeSession = async (
	sessionStore: AgentSessionStore,
	sessionId: string,
	transform: (session: AgentSession) => AgentSession
) => {
	const session = await getRuntimeSession(sessionStore, sessionId)
	if (!session) return null

	const nextSession = transform(session)
	await sessionStore.save(nextSession)
	return nextSession
}
