import type { AgentApiKeyConfig, AilyAgentConfig } from 'shared'

const createAgentApiKeyId = () => `api_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`

/**
 * 返回当前启用的 API Key 配置列表。
 * @param config - 当前 Agent 配置
 */
export const getEnabledAgentApiKeys = (config: AilyAgentConfig): Array<AgentApiKeyConfig> =>
	(config.apiKeys ?? []).filter(item => item.enabled).map(item => ({ ...item }))

/**
 * 添加一条 API Key 配置。
 * @param config - 当前 Agent 配置
 * @param apiKey - 待添加配置
 */
export const addAgentApiKey = (
	config: AilyAgentConfig,
	apiKey: Omit<AgentApiKeyConfig, 'id' | 'enabled'>
): AilyAgentConfig => ({
	...config,
	apiKeys: [...(config.apiKeys ?? []), { ...apiKey, id: createAgentApiKeyId(), enabled: true }]
})

/**
 * 删除一条 API Key 配置，并清理关联模型。
 * @param config - 当前 Agent 配置
 * @param apiKeyId - API Key 配置 ID
 */
export const removeAgentApiKey = (config: AilyAgentConfig, apiKeyId: string): AilyAgentConfig => ({
	...config,
	apiKeys: (config.apiKeys ?? []).filter(item => item.id !== apiKeyId).map(item => ({ ...item })),
	models: (config.models ?? []).map(model =>
		model.apiKeyId === apiKeyId ? { ...model, apiKeyId: undefined } : { ...model }
	)
})

/**
 * 更新一条 API Key 配置。
 * @param config - 当前 Agent 配置
 * @param apiKeyId - API Key 配置 ID
 * @param updates - 要写入的更新字段
 */
export const updateAgentApiKey = (
	config: AilyAgentConfig,
	apiKeyId: string,
	updates: Partial<Omit<AgentApiKeyConfig, 'id'>>
): AilyAgentConfig => ({
	...config,
	apiKeys: (config.apiKeys ?? []).map(item => (item.id === apiKeyId ? { ...item, ...updates } : { ...item }))
})

/**
 * 切换 API Key 的启用状态。
 * @param config - 当前 Agent 配置
 * @param apiKeyId - API Key 配置 ID
 */
export const toggleAgentApiKeyEnabled = (config: AilyAgentConfig, apiKeyId: string): AilyAgentConfig => ({
	...config,
	apiKeys: (config.apiKeys ?? []).map(item =>
		item.id === apiKeyId ? { ...item, enabled: !item.enabled } : { ...item }
	)
})

/**
 * 获取 API Key 的展示名称。
 * @param config - 当前 Agent 配置
 * @param apiKeyId - API Key 配置 ID
 */
export const getAgentApiKeyName = (config: AilyAgentConfig, apiKeyId: string) =>
	config.apiKeys?.find(item => item.id === apiKeyId)?.name ?? '未配置'

/**
 * 判断 API Key 是否可用。
 * @param config - 当前 Agent 配置
 * @param apiKeyId - API Key 配置 ID
 */
export const isAgentApiKeyValid = (config: AilyAgentConfig, apiKeyId: string) => {
	const apiKeyConfig = config.apiKeys?.find(item => item.id === apiKeyId)
	return Boolean(apiKeyConfig && apiKeyConfig.enabled && apiKeyConfig.baseUrl && apiKeyConfig.apiKey)
}

/**
 * 为指定模型绑定 API Key 配置。
 * @param config - 当前 Agent 配置
 * @param modelId - 模型 ID
 * @param apiKeyId - API Key 配置 ID
 */
export const assignAgentApiKeyToModel = (
	config: AilyAgentConfig,
	modelId: string,
	apiKeyId: string | null
): AilyAgentConfig => ({
	...config,
	models: (config.models ?? []).map(model =>
		model.model === modelId ? { ...model, apiKeyId: apiKeyId || undefined } : { ...model }
	)
})
