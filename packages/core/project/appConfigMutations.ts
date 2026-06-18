import { getQuickSendList, getSkippedVersions, getToolbarAppIds } from './appConfig'

import type { AilyAiChatMode, AilyAppConfig, QuickSendItem, SerialMonitorConfig } from 'shared'

/**
 * 更新当前选中的语言。
 * @param config - 当前应用配置
 * @param selectedLanguage - 新语言
 */
export const setSelectedLanguage = (
	config: AilyAppConfig | null | undefined,
	selectedLanguage: string
): AilyAppConfig => ({
	...(config ?? {}),
	selectedLanguage
})

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

/**
 * 追加一条跳过更新版本记录。
 * @param config - 当前应用配置
 * @param version - 要跳过的版本
 */
export const skipAppVersion = (config: AilyAppConfig | null | undefined, version: string): AilyAppConfig => {
	if (!version) return { ...(config ?? {}) }

	const skippedVersions = getSkippedVersions(config)
	if (!skippedVersions.includes(version)) {
		skippedVersions.push(version)
	}

	return {
		...(config ?? {}),
		skippedVersions
	}
}

/**
 * 清空跳过更新版本列表。
 * @param config - 当前应用配置
 */
export const clearSkippedAppVersions = (config: AilyAppConfig | null | undefined): AilyAppConfig => ({
	...(config ?? {}),
	skippedVersions: []
})

/**
 * 更新 toolbar app id 列表。
 * @param config - 当前应用配置
 * @param toolbarAppIds - 新 toolbar app id 列表
 */
export const setToolbarAppIds = (
	config: AilyAppConfig | null | undefined,
	toolbarAppIds: Array<string>
): AilyAppConfig => ({
	...(config ?? {}),
	toolbarAppIds: getToolbarAppIds({ toolbarAppIds })
})

/**
 * 更新快速发送列表。
 * @param config - 当前应用配置
 * @param quickSendList - 新快速发送列表
 */
export const setQuickSendList = (
	config: AilyAppConfig | null | undefined,
	quickSendList: Array<QuickSendItem>
): AilyAppConfig => ({
	...(config ?? {}),
	quickSendList: getQuickSendList({ quickSendList })
})

/**
 * 更新串口监视器配置。
 * @param config - 当前应用配置
 * @param serialMonitor - 新串口监视器配置
 */
export const setSerialMonitorConfig = (
	config: AilyAppConfig | null | undefined,
	serialMonitor: SerialMonitorConfig
): AilyAppConfig => ({
	...(config ?? {}),
	serialMonitor: {
		...(config?.serialMonitor ?? {}),
		...serialMonitor
	}
})
