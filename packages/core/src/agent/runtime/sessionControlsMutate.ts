import { removeIncompleteLastTurn, removeSessionFromTurn, truncateSessionToTurn } from '../session'
import { updateRuntimeSession } from './sessionControlsShared'

import type { AgentSessionStore } from '../session'

/**
 * 截断会话到指定 turn。
 * @param sessionStore - 会话存储
 * @param sessionId - 会话 ID
 * @param turnId - 目标 turn ID
 */
export const truncateRuntimeSessionToTurn = (sessionStore: AgentSessionStore, sessionId: string, turnId: string) =>
	updateRuntimeSession(sessionStore, sessionId, session => truncateSessionToTurn(session, turnId))

/**
 * 删除某个 turn 及其之后的历史。
 * @param sessionStore - 会话存储
 * @param sessionId - 会话 ID
 * @param turnId - 目标 turn ID
 */
export const removeRuntimeSessionFromTurn = (sessionStore: AgentSessionStore, sessionId: string, turnId: string) =>
	updateRuntimeSession(sessionStore, sessionId, session => removeSessionFromTurn(session, turnId))

/**
 * 删除最后一个未完成 turn。
 * @param sessionStore - 会话存储
 * @param sessionId - 会话 ID
 */
export const removeRuntimeIncompleteLastTurn = (sessionStore: AgentSessionStore, sessionId: string) =>
	updateRuntimeSession(sessionStore, sessionId, removeIncompleteLastTurn)
