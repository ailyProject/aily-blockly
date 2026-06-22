import { getToolName, isToolUIPart } from 'ai'

import { createToolCallRoundId, getTextContent } from '../turnsShared'

import type { AgentMessage } from '../../types/message'
import type { AgentToolCallRound, AgentToolExecution, AgentTurnResponse } from './types'

export const extractAgentToolExecutions = (messages: Array<AgentMessage>): Array<AgentToolExecution> => {
	const executions = new Map<string, AgentToolExecution>()

	for (const message of messages) {
		if (message.role !== 'assistant') continue

		for (const part of message.parts) {
			if (!isToolUIPart(part)) continue

			const toolName = getToolName(part)
			executions.set(part.toolCallId, {
				toolCallId: part.toolCallId,
				toolName,
				state: part.state,
				input: 'input' in part ? part.input : undefined,
				output: 'output' in part ? part.output : undefined,
				errorText: 'errorText' in part ? part.errorText : undefined,
				preliminary: 'preliminary' in part ? part.preliminary : undefined
			})
		}
	}

	return [...executions.values()]
}

export const extractAgentToolCallRounds = (messages: Array<AgentMessage>): Array<AgentToolCallRound> => {
	const rounds: Array<AgentToolCallRound> = []
	let stepIndex = 0

	for (const message of messages) {
		if (message.role !== 'assistant') continue
		if (!message.parts.some(part => isToolUIPart(part))) continue

		let currentText = ''
		let currentExecutions: Array<AgentToolExecution> = []
		let sawContent = false

		const flushRound = () => {
			if (!sawContent && currentExecutions.length === 0 && !currentText.trim()) return

			rounds.push({
				id: createToolCallRoundId(stepIndex),
				stepIndex,
				assistantText: currentText.trim(),
				toolExecutions: currentExecutions
			})
			stepIndex += 1
			currentText = ''
			currentExecutions = []
			sawContent = false
		}

		for (const part of message.parts) {
			if (part.type === 'step-start') {
				flushRound()
				continue
			}

			if (part.type === 'text') {
				currentText += part.text
				sawContent = true
				continue
			}

			if (isToolUIPart(part)) {
				currentExecutions.push({
					toolCallId: part.toolCallId,
					toolName: getToolName(part),
					state: part.state,
					input: 'input' in part ? part.input : undefined,
					output: 'output' in part ? part.output : undefined,
					errorText: 'errorText' in part ? part.errorText : undefined,
					preliminary: 'preliminary' in part ? part.preliminary : undefined
				})
				sawContent = true
			}
		}

		flushRound()
	}

	return rounds
}

export const extractFinalAssistantContent = (messages: Array<AgentMessage>) =>
	messages
		.filter(message => message.role === 'assistant')
		.filter(message => !message.parts.some(part => isToolUIPart(part)))
		.map(getTextContent)
		.join('')
		.trim()

export const buildAgentTurnResponse = (messages: Array<AgentMessage>): AgentTurnResponse => ({
	messages,
	assistantText: messages
		.filter(message => message.role === 'assistant')
		.map(getTextContent)
		.join('')
		.trim(),
	content: extractFinalAssistantContent(messages),
	toolCallRounds: extractAgentToolCallRounds(messages)
})
