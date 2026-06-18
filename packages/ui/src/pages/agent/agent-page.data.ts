import type { AgentSessionRequest } from '@ui/workspace/shared'

export const demoAgentRequestBody: Omit<AgentSessionRequest, 'id' | 'text'> = {
	title: 'Aily Agent Demo',
	model: {
		model: 'gpt-5',
		apiKey: 'demo-api-key'
	},
	runtimeConfig: {
		mode: 'agent',
		agentName: 'mainAgent',
		maxSteps: 8
	},
	metadata: {
		source: 'ui-agent-page'
	}
}
