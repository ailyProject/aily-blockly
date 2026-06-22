import type { AgentToolCallRound, AgentTurn } from './turns/types'

/**
 * 清空 turns 和 round 上已有的摘要字段。
 * @param turns - 当前 turn 列表
 */
export const clearTurnSummaries = (turns: Array<AgentTurn>): Array<AgentTurn> =>
	turns.map(
		(turn): AgentTurn => ({
			...turn,
			summary: undefined,
			response: turn.response
				? {
						...turn.response,
						toolCallRounds: turn.response.toolCallRounds.map(
							(round): AgentToolCallRound => ({
								...round,
								summary: undefined
							})
						)
					}
				: turn.response
		})
	)
