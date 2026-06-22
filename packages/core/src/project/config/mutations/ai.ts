import type { AilyAiChatMode, AilyAppConfig } from 'shared'

/**
 * 更新 AI 聊天模式。
 * @param config - 当前应用配置
 * @param mode - 新聊天模式
 */
export const setAiChatMode = (config: AilyAppConfig | null | undefined, mode: AilyAiChatMode): AilyAppConfig => ({
	...(config ?? {}),
	aiChatMode: mode
})

/**
 * 更新当前选中的 AI 模型。
 * @param config - 当前应用配置
 * @param model - 新模型配置
 */
export const setAiChatModel = (
	config: AilyAppConfig | null | undefined,
	model: AilyAppConfig['aiChatModel']
): AilyAppConfig => ({
	...(config ?? {}),
	aiChatModel: model
})
