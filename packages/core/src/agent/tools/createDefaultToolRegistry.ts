import { createAskApprovalTool } from './builtin/askApprovalTool'
import { createAskUserTool } from './builtin/askUserTool'
import { createSearchAvailableToolsTool } from './builtin/searchAvailableToolsTool'
import { AgentToolRegistry } from './registry'

export const createDefaultToolRegistry = () => {
	const registry = new AgentToolRegistry()

	registry.register(createAskUserTool())
	registry.register(createAskApprovalTool())
	registry.register(createSearchAvailableToolsTool(registry))

	return registry
}
