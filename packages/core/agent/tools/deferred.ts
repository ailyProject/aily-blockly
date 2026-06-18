import type { AgentToolDescriptor, DeferredToolListingOptions } from './types'

const canUseTool = (tool: AgentToolDescriptor, options: DeferredToolListingOptions) => {
	if (tool.visibleToAgents && !tool.visibleToAgents.includes(options.agentName)) return false

	if (options.enabledTools?.length && !options.enabledTools.includes(tool.name)) return false

	if (options.disabledTools?.includes(tool.name)) return false

	return true
}

export const buildDeferredToolsListing = (tools: Array<AgentToolDescriptor>, options: DeferredToolListingOptions) => {
	const groups = new Map<string, Array<AgentToolDescriptor>>()

	tools
		.filter(tool => tool.availability === 'deferred')
		.filter(tool => canUseTool(tool, options))
		.forEach(tool => {
			const key = tool.group ?? '其他工具'
			const target = groups.get(key) ?? []
			target.push(tool)
			groups.set(key, target)
		})

	if (groups.size === 0) return ''

	return `<availableTools>\n${[...groups.entries()]
		.map(([group, groupTools]) => {
			const names = groupTools.map(tool => tool.name).join(', ')
			return `- ${group}: ${names}`
		})
		.join('\n')}\n调用 search_available_tools 可按需获取这些工具的完整定义。\n</availableTools>`
}

export const searchDeferredTools = (
	tools: Array<AgentToolDescriptor>,
	query: string,
	options: DeferredToolListingOptions
) => {
	const normalized = query.trim().toLowerCase()

	return tools
		.filter(tool => tool.availability === 'deferred')
		.filter(tool => canUseTool(tool, options))
		.filter(tool => {
			if (!normalized) return true
			return (
				tool.name.toLowerCase().includes(normalized) ||
				tool.description.toLowerCase().includes(normalized) ||
				tool.group?.toLowerCase().includes(normalized) === true ||
				tool.tags?.some(tag => tag.toLowerCase().includes(normalized)) === true
			)
		})
}
