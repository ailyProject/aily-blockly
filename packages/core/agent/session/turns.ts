import { getToolName, isToolUIPart } from 'ai'

import { createMessageId, createSessionId } from '../utils/ids'
import { createTextMessage } from '../utils/messages'

import type { AgentMessage } from '../types/message'

const INFO_TOOL_NAMES = new Set([
	'read_file',
	'fetch',
	'web_search',
	'grep',
	'grep_tool',
	'glob_tool',
	'get_directory_tree',
	'list_directory',
	'search_boards_libraries',
	'get_workspace_overview_tool'
])

/**
 * 工具执行状态
 */
export type AgentToolExecutionState =
	/** 工具输入仍在流式生成中 */
	| 'input-streaming'
	/** 工具输入已确定但尚未产出结果 */
	| 'input-available'
	/** 工具正在等待审批 */
	| 'approval-requested'
	/** 工具审批结果已返回 */
	| 'approval-responded'
	/** 工具输出已可用 */
	| 'output-available'
	/** 工具执行报错 */
	| 'output-error'
	/** 工具被明确拒绝执行 */
	| 'output-denied'

/**
 * 单次工具执行摘要
 */
export interface AgentToolExecution {
	/** 工具调用 ID */
	toolCallId: string
	/** 工具名称 */
	toolName: string
	/** 工具执行状态 */
	state: AgentToolExecutionState
	/** 工具输入 */
	input?: unknown
	/** 工具输出 */
	output?: unknown
	/** 错误文本 */
	errorText?: string
	/** 是否为阶段性结果 */
	preliminary?: boolean
}

/**
 * 单轮工具调用记录
 */
export interface AgentToolCallRound {
	/** round 唯一 ID */
	id: string
	/** round 在一次 turn 中的顺序 */
	stepIndex: number
	/** 工具调用前后的 assistant 文本 */
	assistantText: string
	/** 本轮工具执行列表 */
	toolExecutions: Array<AgentToolExecution>
	/** 用于覆盖更早历史的摘要 */
	summary?: string
}

/**
 * 当前摘要锚点
 */
export interface AgentSummaryAnchor {
	/** 锚定 turn ID */
	turnId: string
	/** 锚定 turn 在会话中的索引 */
	turnIndex: number
	/** 锚定 round ID */
	roundId?: string
	/** 锚定 round 在 turn 中的索引 */
	roundIndex?: number
	/** 摘要内容 */
	summary: string
}

/**
 * turn 在消息数组中的跨度
 */
export interface AgentTurnSpan {
	/** 对应 turn ID */
	turnId: string
	/** turn 顺序索引 */
	turnIndex: number
	/** 消息起始下标，含当前值 */
	startIdx: number
	/** 消息结束下标，不含当前值 */
	endIdx: number
	/** 该 turn 是否包含信息型工具 */
	hasInfoTools: boolean
}

export interface AgentTurnRequest {
	message: AgentMessage
	timestamp: number
	content: string
}

export interface AgentTurnResponse {
	messages: Array<AgentMessage>
	assistantText: string
	content: string
	toolCallRounds: Array<AgentToolCallRound>
}

export interface AgentTurn {
	id: string
	messages: Array<AgentMessage>
	request: AgentTurnRequest
	response?: AgentTurnResponse
	createdAt: number
	hasInfoTools?: boolean
	summary?: string
	toolExecutions?: Array<AgentToolExecution>
}

export interface CreateAgentTurnInput {
	id?: string
	messages: Array<AgentMessage>
	request?: AgentTurnRequest
	response?: AgentTurnResponse
	createdAt?: number
	hasInfoTools?: boolean
	summary?: string
	toolExecutions?: Array<AgentToolExecution>
}

export interface ApplyTurnSummaryArgs {
	turns: Array<AgentTurn>
	turnIds: Array<string>
	anchorTurnId: string
	summary: string
	anchorRoundId?: string
}

export interface BuildTurnMessagesResult {
	messages: Array<AgentMessage>
	turnSpans: Array<AgentTurnSpan>
}

const getTextContent = (message: AgentMessage) =>
	message.parts
		.filter(part => part.type === 'text')
		.map(part => part.text)
		.join('')

const buildTurnRequest = (message: AgentMessage): AgentTurnRequest => ({
	message,
	timestamp: message.metadata?.timestamp ?? Date.now(),
	content: getTextContent(message)
})

const createToolCallRoundId = (stepIndex: number) => `round_${stepIndex}_${createSessionId()}`

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
		if (message.role === 'system') {
			continue
		}

		if (message.role === 'user') {
			flushTurn()
			currentUserMessage = message
			continue
		}

		if (message.role === 'assistant') {
			if (!currentUserMessage) {
				continue
			}
			currentAssistantMessages.push(message)
		}
	}

	flushTurn()

	return turns
}

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

const createSummaryMessage = (turnId: string, summary: string): AgentMessage =>
	createTextMessage({
		role: 'system',
		text: `<conversation-summary turn="${turnId}">\n${summary}\n</conversation-summary>`
	})

const buildToolPart = (execution: AgentToolExecution) => {
	const base = {
		type: 'dynamic-tool' as const,
		toolName: execution.toolName,
		toolCallId: execution.toolCallId
	}

	switch (execution.state) {
		case 'input-streaming':
			return {
				...base,
				state: 'input-streaming' as const,
				...(execution.input !== undefined ? { input: execution.input } : {})
			}
		case 'input-available':
			return {
				...base,
				state: 'input-available' as const,
				input: execution.input
			}
		case 'approval-requested':
			return {
				...base,
				state: 'approval-requested' as const,
				input: execution.input,
				approval: {
					id: execution.toolCallId
				}
			}
		case 'approval-responded':
			return {
				...base,
				state: 'approval-responded' as const,
				input: execution.input,
				approval: {
					id: execution.toolCallId,
					approved: true as const
				}
			}
		case 'output-available':
			return {
				...base,
				state: 'output-available' as const,
				input: execution.input,
				output: execution.output,
				...(execution.preliminary !== undefined ? { preliminary: execution.preliminary } : {})
			}
		case 'output-error':
			return {
				...base,
				state: 'output-error' as const,
				input: execution.input,
				errorText: execution.errorText ?? 'Tool execution failed'
			}
		case 'output-denied':
			return {
				...base,
				state: 'output-denied' as const,
				input: execution.input,
				approval: {
					id: execution.toolCallId,
					approved: false as const,
					...(execution.errorText ? { reason: execution.errorText } : {})
				}
			}
	}
}

const buildToolParts = (toolExecutions: Array<AgentToolExecution>) => toolExecutions.map(buildToolPart)

export const buildMessageFromToolCallRound = (round: AgentToolCallRound): AgentMessage => ({
	id: createMessageId(),
	role: 'assistant',
	metadata: {
		timestamp: Date.now()
	},
	parts: [
		...(round.assistantText ? [{ type: 'text' as const, text: round.assistantText, state: 'done' as const }] : []),
		...buildToolParts(round.toolExecutions)
	]
})

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
				...(turn.response?.content
					? [
							createTextMessage({
								role: 'assistant',
								text: turn.response.content
							})
						]
					: [])
			]
		}

		return [
			...requestMessages,
			...rounds.map(buildMessageFromToolCallRound),
			...(turn.response?.content
				? [
						createTextMessage({
							role: 'assistant',
							text: turn.response.content
						})
					]
				: [])
		]
	}

	const responseMessages = turn.response?.messages ?? turn.messages.filter(message => message.role === 'assistant')

	return [...requestMessages, ...responseMessages]
}

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

export const buildMessagesFromTurns = (turns: Array<AgentTurn>) => buildMessagesFromTurnsWithSpans(turns).messages

export const flattenAgentTurns = (turns: Array<AgentTurn>) => buildMessagesFromTurns(turns)
