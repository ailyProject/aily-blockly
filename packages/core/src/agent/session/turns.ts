import { createSessionId } from '../utils/ids'
import { buildAgentTurnResponse } from './turns/extract'
import { buildTurnRequest, INFO_TOOL_NAMES } from './turnsShared'

import type { AgentMessage } from '../types/message'
import type { AgentTurn, CreateAgentTurnInput } from './turns/types'

export * from './turns/types'
export * from './turns/extract'
export * from './turnsMessages'
export * from './turnsShared'
export * from './turnsSummary'

export const rebuildAgentTurnsFromMessages = (messages: Array<AgentMessage>): Array<AgentTurn> => {
	const turns: Array<AgentTurn> = []
	let currentUserMessage: AgentMessage | null = null
	let currentAssistantMessages: Array<AgentMessage> = []

	const flushTurn = () => {
		if (!currentUserMessage) return

		turns.push(
			createAgentTurn({
				messages: [currentUserMessage, ...currentAssistantMessages]
			})
		)

		currentUserMessage = null
		currentAssistantMessages = []
	}

	for (const message of messages) {
		if (message.role === 'system') continue
		if (message.role === 'user') {
			flushTurn()
			currentUserMessage = message
			continue
		}
		if (message.role === 'assistant' && currentUserMessage) {
			currentAssistantMessages.push(message)
		}
	}

	flushTurn()
	return turns
}

export const createAgentTurn = (input: CreateAgentTurnInput): AgentTurn => {
	const request =
		input.request ??
		(() => {
			const userMessage = input.messages.find(message => message.role === 'user')
			if (!userMessage) {
				throw new Error('Agent turn requires a user request message')
			}
			return buildTurnRequest(userMessage)
		})()

	const response =
		input.response ??
		(() => {
			const responseMessages = input.messages.filter(message => message.role === 'assistant')
			return responseMessages.length > 0 ? buildAgentTurnResponse(responseMessages) : undefined
		})()

	const toolExecutions = input.toolExecutions ?? response?.toolCallRounds.flatMap(round => round.toolExecutions) ?? []

	return {
		id: input.id ?? `turn_${createSessionId()}`,
		messages: input.messages,
		request,
		response,
		createdAt: input.createdAt ?? Date.now(),
		hasInfoTools: input.hasInfoTools ?? toolExecutions.some(execution => INFO_TOOL_NAMES.has(execution.toolName)),
		summary: input.summary,
		toolExecutions
	}
}
