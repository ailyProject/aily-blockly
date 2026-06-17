import { buildMessagesFromTurnsWithSpans } from './turns'

import type { AgentTurn } from './turns'
import type { AgentSession } from './types'

export const deriveSessionHistory = (turns: Array<AgentTurn>) => buildMessagesFromTurnsWithSpans(turns)

/**
 * 基于 turns 重建会话的选项
 */
export interface RebuildSessionFromTurnsOptions {
	/** 是否递增修订号 */
	incrementRevision?: boolean
	/** 指定更新时间 */
	updatedAt?: Date
}

export const rebuildSessionFromTurns = (
	session: AgentSession,
	turns: Array<AgentTurn>,
	options: RebuildSessionFromTurnsOptions = {}
): AgentSession => {
	const derived = deriveSessionHistory(turns)

	return {
		...session,
		turns,
		messages: derived.messages,
		turnSpans: derived.turnSpans,
		revision: options.incrementRevision === false ? session.revision : session.revision + 1,
		updatedAt: options.updatedAt ?? new Date()
	}
}
