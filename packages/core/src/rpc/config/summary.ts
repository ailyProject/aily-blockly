import { DEFAULT_REGION_KEY } from 'shared'

import {
	getAiChatMode,
	getAppDataPathTemplate,
	getBlocklyThemeId,
	getCurrentNpmRegistry,
	getDefaultSerialMonitorInputMode,
	getDefaultSerialMonitorViewMode,
	getMermaidTheme,
	getMonacoTheme,
	getQuickSendList,
	getSelectedLanguage,
	getSkippedVersions,
	getThemeMode,
	getToolbarAppIds,
	isDevmodeEnabled,
	resolveAppDataPath,
	resolveDevmodeConfig,
	resolveSerialMonitorConfig
} from '../../project'

import type { AilyAppConfig } from 'shared'
import type { ConfigSummary } from './types'

/**
 * 把完整配置对象规整为 UI 使用的摘要视图。
 * @param config - 完整应用配置
 * @param options - 额外上下文
 */
export const resolveConfigSummary = (
	config: AilyAppConfig | undefined,
	options: { fallbackLanguage?: string; userHome?: string } = {}
): ConfigSummary => ({
	selectedLanguage: getSelectedLanguage(config, options.fallbackLanguage),
	themeMode: getThemeMode(config),
	monacoTheme: getMonacoTheme(config),
	mermaidTheme: getMermaidTheme(config),
	blocklyThemeId: getBlocklyThemeId(config),
	devmodeEnabled: isDevmodeEnabled(config),
	devmode: resolveDevmodeConfig(config),
	appDataPathTemplate: getAppDataPathTemplate(config),
	appDataPath: options.userHome ? resolveAppDataPath(config, options.userHome) : '',
	npmRegistry: getCurrentNpmRegistry(config?.regions, config?.region, DEFAULT_REGION_KEY),
	toolbarAppIds: getToolbarAppIds(config),
	skippedVersions: getSkippedVersions(config),
	aiChatMode: getAiChatMode(config),
	quickSendList: getQuickSendList(config),
	serialMonitor: resolveSerialMonitorConfig(config),
	serialViewMode: getDefaultSerialMonitorViewMode(),
	serialInputMode: getDefaultSerialMonitorInputMode()
})
