import { DEFAULT_AI_CHAT_MODE, DEFAULT_QUICK_SEND_LIST } from 'shared'

import { normalizeLanguageFileName } from './language'

import type { AilyAiChatMode, AilyAppConfig, QuickSendItem } from 'shared'

/**
 * 读取当前选中的语言，并兼容 fallback 语言归一化。
 * @param config - 应用配置
 * @param fallbackLanguage - 运行时 fallback 语言
 */
export const getSelectedLanguage = (config: AilyAppConfig | null | undefined, fallbackLanguage?: string) =>
	typeof config?.selectedLanguage === 'string' && config.selectedLanguage
		? config.selectedLanguage
		: normalizeLanguageFileName(fallbackLanguage ?? config?.lang)

/**
 * 读取 toolbar app id 列表，并过滤非法项。
 * @param config - 应用配置
 */
export const getToolbarAppIds = (config: AilyAppConfig | null | undefined) =>
	Array.isArray(config?.toolbarAppIds)
		? config.toolbarAppIds.filter((item): item is string => typeof item === 'string')
		: []

/**
 * 读取跳过更新版本列表，并过滤非法项。
 * @param config - 应用配置
 */
export const getSkippedVersions = (config: AilyAppConfig | null | undefined) =>
	Array.isArray(config?.skippedVersions)
		? config.skippedVersions.filter((item): item is string => typeof item === 'string')
		: []

/**
 * 读取 AI 聊天模式，并回退到默认值。
 * @param config - 应用配置
 */
export const getAiChatMode = (config: AilyAppConfig | null | undefined): AilyAiChatMode =>
	config?.aiChatMode === 'ask' ? 'ask' : DEFAULT_AI_CHAT_MODE

/**
 * 读取快速发送列表，并在缺失时返回默认值。
 * @param config - 应用配置
 */
export const getQuickSendList = (config: AilyAppConfig | null | undefined): Array<QuickSendItem> =>
	Array.isArray(config?.quickSendList)
		? config.quickSendList.filter((item): item is QuickSendItem =>
				Boolean(
					item &&
					typeof item === 'object' &&
					typeof item.name === 'string' &&
					typeof item.data === 'string' &&
					(item.type === 'signal' || item.type === 'text' || item.type === 'hex')
				)
			)
		: [...DEFAULT_QUICK_SEND_LIST]
