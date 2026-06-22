import { estimateMessagesTokens } from '../utils'
import { resolveAgentRuntimeDefaults } from './AgentRuntimeDefaults'
import { runAgentRuntime } from './AgentRuntimeRun'
import {
	applyRuntimeSessionSummary,
	createRuntimeSession,
	getRuntimeSession,
	removeRuntimeIncompleteLastTurn,
	removeRuntimeSessionFromTurn,
	saveRuntimeSession,
	truncateRuntimeSessionToTurn
} from './sessionControls'

import type { AgentCapabilities } from '../capabilities'
import type { PromptPipeline } from '../prompts'
import type { AgentSession, AgentSessionStore, ApplySessionSummaryArgs, CreateAgentSessionInput } from '../session'
import type { AgentToolRegistry } from '../tools/registry'
import type { AgentMessage } from '../types/message'
import type { AgentRuntimeEvent } from './events'
import type { AgentRunInput, AgentRunResult, AgentRuntimeOptions } from './types'

export class AgentRuntime {
	readonly capabilities: AgentCapabilities
	readonly sessionStore: AgentSessionStore
	readonly registry: AgentToolRegistry
	readonly promptPipeline: PromptPipeline

	constructor(options: AgentRuntimeOptions = {}) {
		const defaults = resolveAgentRuntimeDefaults(options)
		this.capabilities = defaults.capabilities
		this.sessionStore = defaults.sessionStore
		this.registry = defaults.registry
		this.promptPipeline = defaults.promptPipeline
	}

	async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
		return createRuntimeSession(this.sessionStore, input)
	}

	async getSession(sessionId: string): Promise<AgentSession | null> {
		return getRuntimeSession(this.sessionStore, sessionId)
	}

	async saveSession(session: AgentSession): Promise<AgentSession> {
		return saveRuntimeSession(this.sessionStore, session)
	}

	async truncateToTurn(sessionId: string, turnId: string): Promise<AgentSession | null> {
		return truncateRuntimeSessionToTurn(this.sessionStore, sessionId, turnId)
	}

	async removeFromTurn(sessionId: string, turnId: string): Promise<AgentSession | null> {
		return removeRuntimeSessionFromTurn(this.sessionStore, sessionId, turnId)
	}

	async removeIncompleteLast(sessionId: string): Promise<AgentSession | null> {
		return removeRuntimeIncompleteLastTurn(this.sessionStore, sessionId)
	}

	async applySummary(sessionId: string, args: ApplySessionSummaryArgs) {
		return applyRuntimeSessionSummary(this.sessionStore, sessionId, args)
	}

	async *run(input: AgentRunInput): AsyncGenerator<AgentRuntimeEvent, AgentRunResult, void> {
		return yield* runAgentRuntime(this, input)
	}

	static estimatePromptTokens(messages: Array<AgentMessage>) {
		return estimateMessagesTokens(messages)
	}
}
