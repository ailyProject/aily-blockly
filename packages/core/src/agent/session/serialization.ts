import { createAgentSession } from './createSession'
import { createAgentTurn } from './turns'

import type { SerializedAgentSession, SerializedAgentTurn } from './serialization/types'
import type { AgentTurn } from './turns'
import type { AgentSession } from './types'

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
