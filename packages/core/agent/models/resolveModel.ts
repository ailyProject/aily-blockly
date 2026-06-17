import { createOpenAI } from '@ai-sdk/openai'

import type { ProviderOptions } from '@ai-sdk/provider-utils'
import type { LanguageModel, ToolSet } from 'ai'

export interface AgentModelConfig {
	model: string
	apiKey: string
	baseUrl?: string
	headers?: Record<string, string>
	provider?: 'openai'
	temperature?: number
	topP?: number
	maxOutputTokens?: number
	reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
}

export interface ResolvedAgentModel {
	model: LanguageModel
	providerOptions?: ProviderOptions
	tools?: ToolSet
}

const buildProviderOptions = (config: AgentModelConfig): ProviderOptions | undefined => {
	if (!config.reasoningEffort) return undefined

	return {
		openai: {
			reasoningEffort: config.reasoningEffort
		}
	} satisfies ProviderOptions
}

export const resolveAgentModel = (config: AgentModelConfig): ResolvedAgentModel => {
	const provider = createOpenAI({
		apiKey: config.apiKey,
		baseURL: config.baseUrl,
		headers: config.headers
	})

	return {
		model: provider(config.model),
		providerOptions: buildProviderOptions(config)
	}
}
