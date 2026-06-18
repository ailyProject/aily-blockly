import type { AgentModelConfigOption, AilyAppConfig } from '@shared'

/**
 * 根据配置和已启用模型列表解析当前应使用的 AI 模型。
 * @param config - 当前应用配置
 * @param enabledModels - 已启用模型列表
 */
export const resolveAiChatModelSelection = (
	config: AilyAppConfig | null | undefined,
	enabledModels: Array<AgentModelConfigOption>
) => {
	const savedModel = config?.aiChatModel
	const currentModel = savedModel ? (enabledModels.find(model => model.model === savedModel.model) ?? null) : null

	if (currentModel) {
		return {
			currentModel,
			nextConfig: { ...(config ?? {}), aiChatModel: currentModel },
			fallbackApplied: false
		}
	}

	if (enabledModels.length > 0) {
		return {
			currentModel: enabledModels[0],
			nextConfig: { ...(config ?? {}), aiChatModel: enabledModels[0] },
			fallbackApplied: true
		}
	}

	return {
		currentModel: null,
		nextConfig: { ...(config ?? {}) },
		fallbackApplied: false
	}
}
