import { applySummaryToSession } from '../session'
import { getRuntimeSession } from './sessionControlsShared'

import type { AgentSession, AgentSessionStore, ApplySessionSummaryArgs } from '../session'

/**
 * 把摘要应用到现有会话。
 * @param sessionStore - 会话存储
 * @param sessionId - 会话 ID
 * @param args - 摘要参数
 */
export const applyRuntimeSessionSummary = async (
	sessionStore: AgentSessionStore,
	sessionId: string,
	args: ApplySessionSummaryArgs
): Promise<{ applied: boolean; session: AgentSession | null }> => {
	const session = await getRuntimeSession(sessionStore, sessionId)
	if (!session) {
		return {
			applied: false,
			session: null
		}
	}

	const result = applySummaryToSession(session, args)
	if (result.applied) {
		await sessionStore.save(result.session)
	}

	return result
}
