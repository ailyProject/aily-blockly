import type { AgentRuntimeConfig } from './types'

export type { AgentMode, AgentRuntimeConfig } from './types'

const defaultRuntimeConfig: AgentRuntimeConfig = {
	mode: 'agent',
	agentName: 'mainAgent',
	maxSteps: 24,
	maxPromptTokens: 32_000,
	disabledTools: [],
	useDeferredToolDiscovery: true
}

export const normalizeAgentRuntimeConfig = (input?: Partial<AgentRuntimeConfig>): AgentRuntimeConfig => ({
	mode: input?.mode === 'ask' ? 'ask' : defaultRuntimeConfig.mode,
	agentName: input?.agentName?.trim() || defaultRuntimeConfig.agentName,
	maxSteps: input?.maxSteps && input.maxSteps > 0 ? input.maxSteps : defaultRuntimeConfig.maxSteps,
	maxPromptTokens:
		input?.maxPromptTokens && input.maxPromptTokens > 0 ? input.maxPromptTokens : defaultRuntimeConfig.maxPromptTokens,
	customSystemPrompt: input?.customSystemPrompt?.trim() || undefined,
	currentDate: input?.currentDate,
	enabledTools: input?.enabledTools?.filter(Boolean),
	disabledTools: Array.from(new Set(input?.disabledTools?.filter(Boolean) ?? defaultRuntimeConfig.disabledTools)),
	useDeferredToolDiscovery: input?.useDeferredToolDiscovery ?? defaultRuntimeConfig.useDeferredToolDiscovery
})
