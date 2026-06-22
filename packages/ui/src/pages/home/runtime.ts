import { loadHomePreview } from '@/utils/core'
import {
	agentConfig,
	boardIndex,
	config,
	configMutationInput,
	legacyBoards,
	legacyLibraries,
	toolbarApps
} from '@/workspace'

import type { Core } from '@/utils/core'
import type { AilyAppConfig, RecentModelProject } from 'shared'
import type { HomePageCoreState } from './types'

/**
 * 从 core/rpc 加载首页演示状态。
 * @param core - core tRPC 句柄
 */
export const loadHomePageCoreState = async (core: Core): Promise<HomePageCoreState> => {
	const preview = await loadHomePreview(core, {
		boardIndex,
		legacyBoards,
		legacyLibraries,
		agentConfig,
		config,
		toolbarApps,
		mutationInput: configMutationInput,
		context: {
			fallbackLanguage: config.lang,
			routeUrl: '/main/blockly-editor',
			boardCore: 'esp32',
			isDevMode: false
		}
	})
	const previewConfig = preview.previewConfig as AilyAppConfig
	const previewOnboarding = preview.previewOnboarding as {
		ailyChatOnboardingCompleted?: boolean
	}
	const addedRecentModelProjects = preview.addedRecentModelProjects as {
		recentModelProjects?: Array<RecentModelProject>
	}
	const removedRecentModelProjects = preview.removedRecentModelProjects as {
		recentModelProjects?: Array<RecentModelProject>
	}

	return {
		architectureCategories: preview.boardCategories.categories.slice(0, 4),
		boardValidation: {
			exists: preview.boardValidation.exists,
			fuzzyMatch: preview.boardValidation.fuzzyMatch,
			matchedName: preview.boardValidation.board?.name ?? null
		},
		libraryValidation: {
			exists: preview.libraryValidation.exists,
			fuzzyMatch: preview.libraryValidation.fuzzyMatch,
			matchedName: preview.libraryValidation.library?.name ?? null
		},
		enabledModelCount: preview.enabledModels.length,
		securityOptions: preview.securityOptions.map((option: { name: string; enabled: boolean }) => ({
			name: option.name,
			enabled: option.enabled
		})),
		configSummary: {
			selectedLanguage: preview.configSummary.selectedLanguage,
			themeMode: preview.configSummary.themeMode,
			devmodeEnabled: preview.configSummary.devmode.enabled,
			devmodeAutoSave: preview.configSummary.devmode.autoSave,
			aiChatMode: preview.configSummary.aiChatMode ?? 'agent',
			selectedModel: preview.resolvedModel.currentModel?.name ?? null,
			toolbarAppCount: preview.configSummary.toolbarAppIds.length,
			visibleToolbarAppCount: preview.storeSummary.visibleHeaderIds.length,
			quickSendCount: preview.configSummary.quickSendList.length,
			skippedVersionCount: preview.configSummary.skippedVersions.length,
			serialBaudRate: preview.configSummary.serialMonitor.baudRate,
			serialAutoScroll: preview.configSummary.serialViewMode.autoScroll,
			serialInputHexMode: preview.configSummary.serialInputMode.hexMode,
			serialConnectBaudRate: preview.serialConnect.baudRate,
			recentProjectCount: preview.recentProjects.length,
			recentModelProjectCount: preview.recentModels.length,
			onboardingCompleted: preview.onboarding.onboardingCompleted,
			blocklyOnboardingCompleted: preview.onboarding.blocklyOnboardingCompleted,
			ailyChatOnboardingCompleted: preview.onboarding.ailyChatOnboardingCompleted,
			previewSelectedLanguage: previewConfig.selectedLanguage ?? preview.configSummary.selectedLanguage,
			previewThemeMode: previewConfig.theme === 'light' ? 'light' : 'dark',
			previewDevmodeEnabled: previewConfig.devmode?.enabled ?? preview.configSummary.devmode.enabled,
			previewDevmodeAutoSave: previewConfig.devmode?.autoSave ?? preview.configSummary.devmode.autoSave,
			previewSerialPort: previewConfig.serialMonitor?.port ?? 'unset',
			previewAiChatMode: previewConfig.aiChatMode ?? 'agent',
			previewToolbarAppCount: previewConfig.toolbarAppIds?.length ?? 0,
			previewQuickSendCount: previewConfig.quickSendList?.length ?? 0,
			previewSkippedVersionCount: previewConfig.skippedVersions?.length ?? 0,
			defaultToolbarAppCount: preview.defaultStore.zones.header.length,
			mergedToolbarOrderCount: preview.mergedToolbarOrder.length,
			toggledToolbarAppCount: preview.toggledLayout.zones.header.length,
			resetToolbarAppCount: preview.resetLayout.zones.header.length,
			addedRecentProjectCount: preview.addedRecentProjects.recentlyProjects?.length ?? 0,
			removedRecentProjectCount: preview.removedRecentProjects.recentlyProjects?.length ?? 0,
			previewAilyChatOnboardingCompleted: previewOnboarding.ailyChatOnboardingCompleted ?? false,
			addedRecentModelProjectCount: addedRecentModelProjects.recentModelProjects?.length ?? 0,
			removedRecentModelProjectCount: removedRecentModelProjects.recentModelProjects?.length ?? 0
		}
	}
}
