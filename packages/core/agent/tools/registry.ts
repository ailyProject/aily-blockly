import { buildDeferredToolsListing, searchDeferredTools } from './deferred'

import type { AgentToolDescriptor } from './types'

/**
 * 工具过滤条件
 */
export interface AgentToolFilter {
	/** 当前 agent 名称 */
	agentName: string
	/** 可选启用白名单 */
	enabledTools?: Array<string>
	/** 可选禁用黑名单 */
	disabledTools?: Array<string>
}

export class AgentToolRegistry {
	private readonly tools = new Map<string, AgentToolDescriptor>()

	register(tool: AgentToolDescriptor) {
		this.tools.set(tool.name, tool)
		return this
	}

	get(name: string) {
		return this.tools.get(name)
	}

	getAll() {
		return [...this.tools.values()]
	}

	getToolsForAgent(filter: AgentToolFilter) {
		const disabled = new Set(filter.disabledTools ?? [])
		const enabled = filter.enabledTools?.length ? new Set(filter.enabledTools) : null

		return this.getAll().filter(tool => {
			if (tool.visibleToAgents && !tool.visibleToAgents.includes(filter.agentName)) return false
			if (disabled.has(tool.name)) return false
			if (enabled && !enabled.has(tool.name)) return false
			return true
		})
	}

	getDeferredToolsListing(filter: AgentToolFilter) {
		return buildDeferredToolsListing(this.getAll(), filter)
	}

	searchDeferredTools(query: string, filter: AgentToolFilter) {
		return searchDeferredTools(this.getAll(), query, filter)
	}
}
