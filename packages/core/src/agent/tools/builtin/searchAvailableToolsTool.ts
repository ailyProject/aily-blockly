import { object, string } from 'zod'

import type { AgentToolRegistry } from '../registry'
import type { AgentToolDescriptor } from '../types'

interface SearchAvailableToolsInput {
	query: string
}

export const createSearchAvailableToolsTool = (
	registry: AgentToolRegistry
): AgentToolDescriptor<SearchAvailableToolsInput> => ({
	name: 'search_available_tools',
	description: 'Search deferred tools and return their structured metadata for later use in the same session.',
	inputSchema: object({
		query: string().trim().default('')
	}),
	execute: (input, context) =>
		registry
			.searchDeferredTools(input.query, {
				agentName: context.runtimeConfig.agentName
			})
			.map(tool => ({
				name: tool.name,
				description: tool.description,
				group: tool.group,
				tags: tool.tags ?? []
			}))
})
