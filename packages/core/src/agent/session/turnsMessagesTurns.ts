import { createTextMessage } from '../utils/messages'
import { buildMessageFromToolCallRound, createSummaryMessage } from './turnsMessagesRounds'

import type { AgentMessage } from '../types/message'
import type { AgentTurn, AgentTurnSpan, BuildTurnMessagesResult } from './turns/types'

/**
 * 从单个结构化 turn 重建消息数组。
 * @param turn - 单个结构化 turn
 */
export const buildMessagesFromTurn = (turn: AgentTurn): Array<AgentMessage> => {
	if (turn.summary?.trim()) {
		return [createSummaryMessage(turn.id, turn.summary.trim())]
	}

	const requestMessages = [turn.request.message]
	const rounds = turn.response?.toolCallRounds ?? []
	if (rounds.length > 0) {
		const anchorRoundIndex = [...rounds]
			.map((round, index) => ({ round, index }))
			.reverse()
			.find(entry => entry.round.summary?.trim())?.index

		if (typeof anchorRoundIndex === 'number') {
			const anchorSummary = rounds[anchorRoundIndex]?.summary?.trim()
			const summaryMessages = anchorSummary ? [createSummaryMessage(turn.id, anchorSummary)] : []
			return [
				...summaryMessages,
				...rounds.slice(anchorRoundIndex + 1).map(buildMessageFromToolCallRound),
				...(turn.response?.content ? [createTextMessage({ role: 'assistant', text: turn.response.content })] : [])
			]
		}

		return [
			...requestMessages,
			...rounds.map(buildMessageFromToolCallRound),
			...(turn.response?.content ? [createTextMessage({ role: 'assistant', text: turn.response.content })] : [])
		]
	}

	const responseMessages = turn.response?.messages ?? turn.messages.filter(message => message.role === 'assistant')
	return [...requestMessages, ...responseMessages]
}

/**
 * 从结构化 turns 重建消息数组，并附带 span 信息。
 * @param turns - 结构化 turn 列表
 */
export const buildMessagesFromTurnsWithSpans = (turns: Array<AgentTurn>): BuildTurnMessagesResult => {
	const messages: Array<AgentMessage> = []
	const turnSpans: Array<AgentTurnSpan> = []

	turns.forEach((turn, turnIndex) => {
		const startIdx = messages.length
		const turnMessages = buildMessagesFromTurn(turn)
		messages.push(...turnMessages)
		turnSpans.push({
			turnId: turn.id,
			turnIndex,
			startIdx,
			endIdx: messages.length,
			hasInfoTools: Boolean(turn.hasInfoTools)
		})
	})

	return {
		messages,
		turnSpans
	}
}

/**
 * 从结构化 turns 重建消息数组。
 * @param turns - 结构化 turn 列表
 */
export const buildMessagesFromTurns = (turns: Array<AgentTurn>) => buildMessagesFromTurnsWithSpans(turns).messages

/**
 * 扁平化结构化 turns。
 * @param turns - 结构化 turn 列表
 */
export const flattenAgentTurns = (turns: Array<AgentTurn>) => buildMessagesFromTurns(turns)
