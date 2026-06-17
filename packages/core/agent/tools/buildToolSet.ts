import { tool } from 'ai'

import type { AgentCapabilities } from '../capabilities/types'
import type { AgentRuntimeEventSink } from '../runtime/events'
import type { AgentRuntimeConfig } from '../session/config'
import type { AgentSession } from '../session/types'
import type { AgentToolRegistry } from './registry'

export interface BuildToolSetArgs {
	registry: AgentToolRegistry
	session: AgentSession
	runtimeConfig: AgentRuntimeConfig
	capabilities: AgentCapabilities
	signal?: AbortSignal
	emit: AgentRuntimeEventSink
}

export const buildToolSet = ({ registry, session, runtimeConfig, capabilities, signal, emit }: BuildToolSetArgs) => {
	const descriptors = registry.getToolsForAgent({
		agentName: runtimeConfig.agentName,
		enabledTools: runtimeConfig.enabledTools,
		disabledTools: runtimeConfig.disabledTools
	})

	return Object.fromEntries(
		descriptors.map(descriptor => [
			descriptor.name,
			tool({
				description: descriptor.description,
				inputSchema: descriptor.inputSchema,
				execute: async input =>
					descriptor.execute(input, {
						session,
						runtimeConfig,
						capabilities,
						signal,
						emit
					})
			})
		])
	)
}
