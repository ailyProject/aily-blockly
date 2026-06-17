import type { AgentCapabilities } from '../capabilities'
import type { AgentModelConfig } from '../models'
import type { PromptPipeline } from '../prompts'
import type {
	AgentRuntimeConfig,
	AgentSession,
	AgentSessionStore,
	ApplySessionSummaryArgs,
	CreateAgentSessionInput
} from '../session'
import type { AgentToolRegistry } from '../tools/registry'
import type { AgentMessage } from '../types/message'

export interface AgentRuntimeOptions {
	capabilities?: AgentCapabilities
	sessionStore?: AgentSessionStore
	registry?: AgentToolRegistry
	promptPipeline?: PromptPipeline
}

export interface AgentRunInput {
	sessionId?: string
	title?: string
	text: string
	model: AgentModelConfig
	runtimeConfig?: Partial<AgentRuntimeConfig>
	metadata?: Record<string, unknown>
	signal?: AbortSignal
}

export interface AgentRunResult {
	session: AgentSession
	responseMessages: Array<AgentMessage>
}

export interface AgentRuntimeSessionControls {
	createSession(input: CreateAgentSessionInput): Promise<AgentSession>
	getSession(sessionId: string): Promise<AgentSession | null>
	saveSession(session: AgentSession): Promise<AgentSession>
	truncateToTurn(sessionId: string, turnId: string): Promise<AgentSession | null>
	removeFromTurn(sessionId: string, turnId: string): Promise<AgentSession | null>
	removeIncompleteLast(sessionId: string): Promise<AgentSession | null>
	applySummary(
		sessionId: string,
		args: ApplySessionSummaryArgs
	): Promise<{ applied: boolean; session: AgentSession | null }>
}
