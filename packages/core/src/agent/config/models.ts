import { AUTO_AGENT_MODEL, DEFAULT_AGENT_MODELS } from '@shared'

import type { AgentModelConfigOption, AilyAgentConfig } from '@shared'

/**
 * 返回当前可用于下拉展示的模型列表。
 * @param config - 当前 Agent 配置
 */
export const getEnabledAgentModels = (config: AilyAgentConfig): Array<AgentModelConfigOption> => {
	const models = config.models?.length ? config.models : DEFAULT_AGENT_MODELS
	const enabledModels = models.filter(model => model.enabled)
	const resultModels =
		config.useCustomApiKey || enabledModels.some(model => model.isCustom && model.apiKey && model.baseUrl)
			? enabledModels
			: enabledModels.filter(model => !model.isCustom)

	return [AUTO_AGENT_MODEL, ...resultModels.map(model => ({ ...model }))]
}

/**
 * 添加一条自定义模型配置。
 * @param config - 当前 Agent 配置
 * @param model - 待添加模型
 */
export const addCustomAgentModel = (
	config: AilyAgentConfig,
	model: Omit<AgentModelConfigOption, 'isCustom'>
): AilyAgentConfig => ({
	...config,
	models: [...(config.models ?? []), { ...model, isCustom: true }]
})

/**
 * 删除一条自定义模型配置。
 * @param config - 当前 Agent 配置
 * @param modelId - 模型 ID
 */
export const removeCustomAgentModel = (config: AilyAgentConfig, modelId: string): AilyAgentConfig => ({
	...config,
	models: (config.models ?? []).filter(model => !(model.model === modelId && model.isCustom))
})

/**
 * 更新单个模型的启用状态。
 * @param config - 当前 Agent 配置
 * @param modelId - 模型 ID
 * @param enabled - 是否启用
 */
export const updateAgentModelEnabled = (
	config: AilyAgentConfig,
	modelId: string,
	enabled: boolean
): AilyAgentConfig => ({
	...config,
	models: (config.models ?? []).map(model => (model.model === modelId ? { ...model, enabled } : { ...model }))
})

/**
 * 将模型列表重置为默认值。
 * @param config - 当前 Agent 配置
 */
export const resetAgentModels = (config: AilyAgentConfig): AilyAgentConfig => ({
	...config,
	models: [...DEFAULT_AGENT_MODELS]
})
