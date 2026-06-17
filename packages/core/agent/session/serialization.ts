import { createAgentSession } from './createSession'
import { createAgentTurn } from './turns'

import type { AgentMessage } from '../types/message'
import type { AgentToolCallRound, AgentToolExecution, AgentTurn, AgentTurnRequest, AgentTurnResponse } from './turns'
import type { AgentSession } from './types'

export interface SerializedAgentTurnRequest extends AgentTurnRequest {
	message: AgentMessage
}

export interface SerializedAgentTurnResponse extends Omit<AgentTurnResponse, 'toolCallRounds'> {
	toolCallRounds: Array<AgentToolCallRound>
}

export interface SerializedAgentTurn {
	id: string
	messages: Array<AgentMessage>
	request: SerializedAgentTurnRequest
	response?: SerializedAgentTurnResponse
	createdAt: number
	hasInfoTools?: boolean
	summary?: string
	toolExecutions?: Array<AgentToolExecution>
}

export interface SerializedAgentSession {
	id: string
	title: string
	messages: Array<AgentMessage>
	turns: Array<SerializedAgentTurn>
	turnSpans: AgentSession['turnSpans']
	revision: number
	runtimeConfig: AgentSession['runtimeConfig']
	metadata: Record<string, unknown>
	createdAt: string
	updatedAt: string
}

const serializeTurn = (turn: AgentTurn): SerializedAgentTurn => ({
	id: turn.id,
	messages: turn.messages,
	request: turn.request,
	response: turn.response,
	createdAt: turn.createdAt,
	hasInfoTools: turn.hasInfoTools,
	summary: turn.summary,
	toolExecutions: turn.toolExecutions
})

const deserializeTurn = (turn: SerializedAgentTurn): AgentTurn =>
	createAgentTurn({
		id: turn.id,
		messages: turn.messages,
		request: turn.request,
		response: turn.response,
		createdAt: turn.createdAt,
		hasInfoTools: turn.hasInfoTools,
		summary: turn.summary,
		toolExecutions: turn.toolExecutions
	})

export const serializeAgentSession = (session: AgentSession): SerializedAgentSession => ({
	id: session.id,
	title: session.title,
	messages: session.messages,
	turns: session.turns.map(serializeTurn),
	turnSpans: session.turnSpans,
	revision: session.revision,
	runtimeConfig: session.runtimeConfig,
	metadata: session.metadata,
	createdAt: session.createdAt.toISOString(),
	updatedAt: session.updatedAt.toISOString()
})

export const deserializeAgentSession = (session: SerializedAgentSession): AgentSession =>
	createAgentSession({
		id: session.id,
		title: session.title,
		turns: session.turns.map(deserializeTurn),
		turnSpans: session.turnSpans,
		revision: session.revision,
		runtimeConfig: session.runtimeConfig,
		metadata: session.metadata,
		createdAt: new Date(session.createdAt),
		updatedAt: new Date(session.updatedAt)
	})
