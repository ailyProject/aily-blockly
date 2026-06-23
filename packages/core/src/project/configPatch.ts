import {
	clearSkippedAppVersions,
	setAiChatMode,
	setDevmodeAutoSave,
	setDevmodeEnabled,
	setQuickSendList,
	setRegion,
	setResourceSource,
	setResourceSources,
	setSelectedLanguage,
	setSerialMonitorConfig,
	setThemeMode,
	setToolbarAppIds,
	skipAppVersion
} from './index'

import type {
	AilyAiChatMode,
	AilyAppConfig,
	QuickSendItem,
	ResourceSourceConfig,
	SerialMonitorConfig,
	ThemeMode
} from 'shared'

/**
 * 应用配置更新片段。
 */
export interface ProjectConfigPatch {
	/** 要跳过的版本号。 */
	versionToSkip?: string
	/** 是否清空跳过版本。 */
	clearSkippedVersions?: boolean
	/** 新主题模式。 */
	themeMode?: ThemeMode
	/** 新区域键。 */
	region?: string
	/** 新资源源键。 */
	resourceSource?: string
	/** 新资源源列表。 */
	resourceSources?: Array<Partial<ResourceSourceConfig>>
	/** 新 AI 聊天模式。 */
	aiChatMode?: AilyAiChatMode
	/** 新选中语言。 */
	selectedLanguage?: string
	/** 是否开启 devmode。 */
	devmodeEnabled?: boolean
	/** 是否开启 devmode 自动保存。 */
	devmodeAutoSave?: boolean
	/** 新的 toolbar app 列表。 */
	toolbarAppIds?: Array<string>
	/** 新的 quick send 列表。 */
	quickSendList?: Array<QuickSendItem>
	/** 新的 serial monitor 配置。 */
	serialMonitor?: SerialMonitorConfig
}

/**
 * 按统一规则把配置 patch 应用到当前配置对象。
 * @param currentConfig - 当前配置
 * @param patch - 要应用的配置片段
 */
export const applyProjectConfigPatch = (
	currentConfig: AilyAppConfig | null | undefined,
	patch: ProjectConfigPatch
): AilyAppConfig => {
	let nextConfig = currentConfig ?? {}

	if (patch.versionToSkip) nextConfig = skipAppVersion(nextConfig, patch.versionToSkip)
	if (patch.clearSkippedVersions) nextConfig = clearSkippedAppVersions(nextConfig)
	if (patch.themeMode) nextConfig = setThemeMode(nextConfig, patch.themeMode)
	if (patch.region) nextConfig = setRegion(nextConfig, patch.region)
	if (patch.resourceSource) nextConfig = setResourceSource(nextConfig, patch.resourceSource)
	if (patch.resourceSources) nextConfig = setResourceSources(nextConfig, patch.resourceSources)
	if (patch.aiChatMode) nextConfig = setAiChatMode(nextConfig, patch.aiChatMode)
	if (patch.selectedLanguage) nextConfig = setSelectedLanguage(nextConfig, patch.selectedLanguage)
	if (typeof patch.devmodeEnabled === 'boolean') nextConfig = setDevmodeEnabled(nextConfig, patch.devmodeEnabled)
	if (typeof patch.devmodeAutoSave === 'boolean') nextConfig = setDevmodeAutoSave(nextConfig, patch.devmodeAutoSave)
	if (patch.toolbarAppIds) nextConfig = setToolbarAppIds(nextConfig, patch.toolbarAppIds)
	if (patch.quickSendList) nextConfig = setQuickSendList(nextConfig, patch.quickSendList)
	if (patch.serialMonitor) nextConfig = setSerialMonitorConfig(nextConfig, patch.serialMonitor)

	return nextConfig
}
