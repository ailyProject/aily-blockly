import { clearTurnSummaries } from './turnsSummaryClear'

import type { ApplyTurnSummaryArgs } from './turns/types'

/**
 * 把摘要应用到指定 turns 前缀及可选的 round 锚点。
 * @param args - turns、覆盖范围和摘要文本
 */
export const applySummaryToTurns = (args: ApplyTurnSummaryArgs) => {
	const summary = args.summary.trim()
	if (!summary || args.turnIds.length === 0) {
		return {
			applied: false,
			turns: args.turns
		}
	}

	const anchorTurnIndex = args.turns.findIndex(turn => turn.id === args.anchorTurnId)
	if (anchorTurnIndex < 0) {
		return {
			applied: false,
			turns: args.turns
		}
	}

	const expectedCoveredIds = args.turns.slice(0, anchorTurnIndex + 1).map(turn => turn.id)
	if (
		args.turnIds.length !== expectedCoveredIds.length ||
		!args.turnIds.every((id, index) => id === expectedCoveredIds[index])
	) {
		return {
			applied: false,
			turns: args.turns
		}
	}

	const turnsWithoutSummaries = clearTurnSummaries(args.turns)
	const anchorTurn = turnsWithoutSummaries[anchorTurnIndex]

	if (args.anchorRoundId) {
		const rounds = anchorTurn.response?.toolCallRounds ?? []
		const anchorRoundIndex = rounds.findIndex(round => round.id === args.anchorRoundId)
		if (anchorRoundIndex < 0 || !anchorTurn.response) {
			return {
				applied: false,
				turns: args.turns
			}
		}

		const nextTurns = [...turnsWithoutSummaries]
		nextTurns[anchorTurnIndex] = {
			...anchorTurn,
			response: {
				...anchorTurn.response,
				toolCallRounds: rounds.map((round, index) =>
					index === anchorRoundIndex
						? {
								...round,
								summary
							}
						: round
				)
			}
		}

		return {
			applied: true,
			turns: nextTurns
		}
	}

	const nextTurns = [...turnsWithoutSummaries]
	nextTurns[anchorTurnIndex] = {
		...anchorTurn,
		summary
	}

	return {
		applied: true,
		turns: nextTurns
	}
}
