import type { AgentSessionRequest } from 'shared'

export const agentRequestSeed: Omit<AgentSessionRequest, 'id' | 'text'> = {
	title: 'Aily Agent Session',
	model: {
		model: 'gpt-5',
		apiKey: 'local-api-key'
	},
	runtimeConfig: {
		mode: 'agent',
		agentName: 'mainAgent',
		maxSteps: 8
	},
	metadata: {
		source: 'ui-agent'
	}
}
