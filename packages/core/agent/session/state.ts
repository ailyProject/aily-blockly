import { buildMessagesFromTurnsWithSpans } from './turns'

import type { AgentTurn } from './turns'
import type { AgentSession } from './types'

export const deriveSessionHistory = (turns: Array<AgentTurn>) => buildMessagesFromTurnsWithSpans(turns)

export interface RebuildSessionFromTurnsOptions {
	incrementRevision?: boolean
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
