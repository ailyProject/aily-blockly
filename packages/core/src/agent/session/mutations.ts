import { rebuildSessionFromTurns } from './state'
import { applySummaryToTurns } from './turns'

import type { AgentSession, ApplySessionSummaryArgs } from './types'

export const truncateSessionToTurn = (session: AgentSession, turnId: string): AgentSession => {
	const index = session.turns.findIndex(turn => turn.id === turnId)
	if (index < 0) return session

	const targetTurn = session.turns[index]
	const truncatedTurn = {
		...targetTurn,
		response: undefined,
		toolExecutions: undefined,
		summary: undefined
	}

	return rebuildSessionFromTurns(session, [...session.turns.slice(0, index), truncatedTurn])
}

export const removeSessionFromTurn = (session: AgentSession, turnId: string): AgentSession => {
	const index = session.turns.findIndex(turn => turn.id === turnId)
	if (index < 0) return session

	return rebuildSessionFromTurns(session, session.turns.slice(0, index))
}

export const removeIncompleteLastTurn = (session: AgentSession): AgentSession => {
	if (session.turns.length === 0) return session
	const lastTurn = session.turns[session.turns.length - 1]
	if (lastTurn.response) return session

	return rebuildSessionFromTurns(session, session.turns.slice(0, -1))
}

export const applySummaryToSession = (session: AgentSession, args: ApplySessionSummaryArgs) => {
	if (typeof args.expectedRevision === 'number' && args.expectedRevision !== session.revision) {
		return {
			applied: false,
			session
		}
	}

	const result = applySummaryToTurns({
		turns: session.turns,
		turnIds: args.turnIds,
		anchorTurnId: args.anchorTurnId,
		summary: args.summary,
		anchorRoundId: args.anchorRoundId
	})

	if (!result.applied) {
		return {
			applied: false,
			session
		}
	}

	return {
		applied: true,
		session: rebuildSessionFromTurns(session, result.turns)
	}
}
