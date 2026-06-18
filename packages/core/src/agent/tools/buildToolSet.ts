import { tool } from 'ai'

import type { BuildToolSetArgs } from './types'

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
