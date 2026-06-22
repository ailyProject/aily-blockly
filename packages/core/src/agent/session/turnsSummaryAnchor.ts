import type { AgentSummaryAnchor, AgentTurn } from './turns/types'

/**
 * 从 turns 尾部向前查找最近一个可用摘要锚点。
 * @param turns - 当前 turn 列表
 */
export const findSummaryAnchor = (turns: Array<AgentTurn>): AgentSummaryAnchor | null => {
	for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
		const turn = turns[turnIndex]
		const rounds = turn.response?.toolCallRounds ?? []

		for (let roundIndex = rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
			const summary = rounds[roundIndex]?.summary?.trim()
			if (!summary) continue

			return {
				turnId: turn.id,
				turnIndex,
				roundId: rounds[roundIndex].id,
				roundIndex,
				summary
			}
		}

		const turnSummary = turn.summary?.trim()
		if (!turnSummary) continue

		return {
			turnId: turn.id,
			turnIndex,
			summary: turnSummary
		}
	}

	return null
}
