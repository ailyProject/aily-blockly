import { createOpenAI } from '@ai-sdk/openai'

import type { ProviderOptions } from '@ai-sdk/provider-utils'
import type { AgentModelConfig, ResolvedAgentModel } from './types'

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
