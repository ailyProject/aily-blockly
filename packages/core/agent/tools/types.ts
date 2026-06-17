import type { ZodTypeAny } from 'zod'
import type { AgentCapabilities } from '../capabilities/types'
import type { AgentRuntimeEventSink } from '../runtime/events'
import type { AgentRuntimeConfig } from '../session/config'
import type { AgentSession } from '../session/types'

export interface AgentToolExecutionContext {
	session: AgentSession
	runtimeConfig: AgentRuntimeConfig
	capabilities: AgentCapabilities
	signal?: AbortSignal
	emit: AgentRuntimeEventSink
}

export interface AgentToolDescriptor<TInput = unknown, TOutput = unknown> {
	name: string
	description: string
	inputSchema: ZodTypeAny
	availability?: 'core' | 'deferred'
	group?: string
	tags?: Array<string>
	visibleToAgents?: Array<string>
	execute(input: TInput, context: AgentToolExecutionContext): Promise<TOutput> | TOutput
}
