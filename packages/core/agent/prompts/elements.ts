import type { AgentCapabilities } from '../capabilities/types'
import type { AgentRuntimeConfig } from '../session/config'
import type { AgentSession } from '../session/types'
import type { AgentToolRegistry } from '../tools/registry'
import type { AgentMessage } from '../types/message'

export enum PromptPriority {
	CURRENT_TURN = 899,
	CONTEXT_INJECTION = 750,
	HISTORY = 700,
	HISTORY_OLDEST = 100,
	TOOL_CONTINUATION = 690
}

export interface PromptElement {
	id: string
	priority: number
	messages: Array<AgentMessage>
	tokens: number
	evictable?: boolean
	children?: Array<PromptElement>
}

export interface PromptBuildContext {
	session: AgentSession
	runtimeConfig: AgentRuntimeConfig
	registry: AgentToolRegistry
	capabilities: AgentCapabilities
	toolCallingIteration: number
}

export interface PromptRenderBreakdown {
	id: string
	priority: number
	tokens: number
	messageCount: number
	evicted: boolean
}

export interface PromptRenderResult {
	messages: Array<AgentMessage>
	totalTokens: number
	budget: number
	evictedCount: number
	elementBreakdown: Array<PromptRenderBreakdown>
}

export interface PromptElementProvider {
	id: string
	build(context: PromptBuildContext): Promise<PromptElement | null> | PromptElement | null
}
