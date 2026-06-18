import {
	DEFAULT_AGENT_AUTO_SAVE_EDITS,
	DEFAULT_AGENT_COMPRESSION_THRESHOLD_RATIO,
	DEFAULT_AGENT_CONTEXT_WINDOW_SIZE,
	DEFAULT_AGENT_MAX_COUNT,
	DEFAULT_AGENT_SUBAGENT_TIMEOUT,
	DEFAULT_AGENT_SUMMARIZATION_THRESHOLD_RATIO,
	DEFAULT_AILY_AGENT_CONFIG
} from 'shared'

import type { AgentToolsConfig, AilyAgentConfig } from 'shared'

const defaultMainAgentTools = (): AgentToolsConfig => ({ enabledTools: [], disabledTools: [] })

const clampRatio = (value: unknown, fallback: number) => {
	if (typeof value !== 'number' || Number.isNaN(value)) return fallback
	return Math.max(0, Math.min(1, value))
}

/**
 * 归一化 Agent 配置，并吸收旧版本兼容字段。
 * @param value - 原始配置值
 */
export const normalizeAilyAgentConfig = (value: unknown): AilyAgentConfig => {
	const source = value && typeof value === 'object' ? (value as AilyAgentConfig) : {}
	const mainAgentTools = source.agentTools?.mainAgent ?? defaultMainAgentTools()

	const normalized: AilyAgentConfig = {
		...DEFAULT_AILY_AGENT_CONFIG,
		...source,
		maxCount: typeof source.maxCount === 'number' ? source.maxCount : DEFAULT_AGENT_MAX_COUNT,
		subagentTimeout:
			typeof source.subagentTimeout === 'number' ? source.subagentTimeout : DEFAULT_AGENT_SUBAGENT_TIMEOUT,
		contextWindowSize:
			typeof source.contextWindowSize === 'number' ? source.contextWindowSize : DEFAULT_AGENT_CONTEXT_WINDOW_SIZE,
		compressionThresholdRatio: clampRatio(source.compressionThresholdRatio, DEFAULT_AGENT_COMPRESSION_THRESHOLD_RATIO),
		summarizationThresholdRatio: clampRatio(
			source.summarizationThresholdRatio,
			DEFAULT_AGENT_SUMMARIZATION_THRESHOLD_RATIO
		),
		autoSaveEdits: typeof source.autoSaveEdits === 'boolean' ? source.autoSaveEdits : DEFAULT_AGENT_AUTO_SAVE_EDITS,
		enabledTools: Array.isArray(source.enabledTools) ? [...source.enabledTools] : [...mainAgentTools.enabledTools],
		disabledTools: Array.isArray(source.disabledTools) ? [...source.disabledTools] : [...mainAgentTools.disabledTools],
		agentTools: {
			...(source.agentTools ?? {}),
			mainAgent: {
				enabledTools: Array.isArray(mainAgentTools.enabledTools)
					? [...mainAgentTools.enabledTools]
					: [...(source.enabledTools ?? [])],
				disabledTools: Array.isArray(mainAgentTools.disabledTools)
					? [...mainAgentTools.disabledTools]
					: [...(source.disabledTools ?? [])]
			}
		},
		securityWorkspaces: {
			project: source.securityWorkspaces?.project ?? true,
			library: source.securityWorkspaces?.library ?? true
		},
		apiKeys: Array.isArray(source.apiKeys) ? source.apiKeys.map(item => ({ ...item })) : [],
		models: Array.isArray(source.models) ? source.models.map(item => ({ ...item })) : []
	}

	return migrateLegacyAilyAgentConfig(normalized)
}

/**
 * 迁移旧版兼容字段到当前配置模型。
 * @param config - 已归一化配置
 */
export const migrateLegacyAilyAgentConfig = (config: AilyAgentConfig): AilyAgentConfig => {
	let nextConfig = { ...config }

	if (nextConfig.baseUrl && nextConfig.apiKey && (nextConfig.apiKeys?.length ?? 0) === 0) {
		nextConfig = {
			...nextConfig,
			apiKeys: [
				{
					id: 'default-config',
					name: '默认配置',
					baseUrl: nextConfig.baseUrl,
					apiKey: nextConfig.apiKey,
					enabled: true
				}
			]
		}
	}

	nextConfig.models = (nextConfig.models ?? []).map(model => {
		if (!model.apiKeyId || model.baseUrl || model.apiKey) {
			return { ...model }
		}

		const apiKeyConfig = nextConfig.apiKeys?.find(item => item.id === model.apiKeyId)
		return apiKeyConfig ? { ...model, baseUrl: apiKeyConfig.baseUrl, apiKey: apiKeyConfig.apiKey } : { ...model }
	})

	return nextConfig
}
