import type { AgentMessage } from '../types/message'
import type { AgentRuntimeConfig } from './config'
import type { AgentTurn, AgentTurnSpan } from './turns'

export interface AgentSession {
	id: string
	title: string
	messages: Array<AgentMessage>
	turns: Array<AgentTurn>
	turnSpans: Array<AgentTurnSpan>
	revision: number
	runtimeConfig: AgentRuntimeConfig
	metadata: Record<string, unknown>
	createdAt: Date
	updatedAt: Date
}

export interface CreateAgentSessionInput {
	id?: string
	title?: string
	messages?: Array<AgentMessage>
	turns?: Array<AgentTurn>
	turnSpans?: Array<AgentTurnSpan>
	revision?: number
	runtimeConfig?: Partial<AgentRuntimeConfig>
	metadata?: Record<string, unknown>
	createdAt?: Date
	updatedAt?: Date
}

export interface AgentSessionStore {
	get(sessionId: string): Promise<AgentSession | null>
	save(session: AgentSession): Promise<void>
	delete(sessionId: string): Promise<void>
	list(): Promise<Array<AgentSession>>
}
