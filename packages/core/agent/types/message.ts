import type { LanguageModelUsage, UIDataTypes, UIMessage, UITools } from 'ai'

export interface AgentStateData {
	id: string
	state: 'doing' | 'done' | 'warn' | 'error'
	text: string
}

export interface AgentDataParts extends UIDataTypes {
	'agent-state': AgentStateData
}

export interface AgentMessageMetadata {
	timestamp: number
	source?: string
	model?: string
	usage?: LanguageModelUsage
}

export type AgentUiTools = UITools
export type AgentMessage = UIMessage<AgentMessageMetadata, AgentDataParts, AgentUiTools> & { createdAt?: Date }
