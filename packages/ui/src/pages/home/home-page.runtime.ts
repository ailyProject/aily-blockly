import {
	demoAgentConfig,
	demoAppConfig,
	demoAppConfigMutationInput,
	demoBoardIndex,
	demoLegacyBoards,
	demoLegacyLibraries,
	demoRecentProject,
	demoToolbarApps
} from './home-page.data'
import type { HomePageCoreState } from './types'

import { loadHomePreview } from '@ui/core-service'
import type { Core } from '@ui/core-service'

/**
 * 从 core/rpc 加载首页演示状态。
 * @param core - core tRPC 句柄
 */
export const loadHomePageCoreState = async (core: Core): Promise<HomePageCoreState> => {
	const preview = await loadHomePreview(core, {
		boardIndex: demoBoardIndex,
		legacyBoards: demoLegacyBoards,
		legacyLibraries: demoLegacyLibraries,
		agentConfig: demoAgentConfig,
		appConfig: demoAppConfig,
		toolbarApps: demoToolbarApps,
		mutationInput: demoAppConfigMutationInput,
		context: {
			fallbackLanguage: demoAppConfig.lang,
			routeUrl: '/main/blockly-editor',
			boardCore: 'esp32',
			isDevMode: false
		}
	})

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
		appConfigSummary: {
			selectedLanguage: preview.appConfigSummary.selectedLanguage,
			themeMode: preview.appConfigSummary.themeMode,
			devmodeEnabled: preview.appConfigSummary.devmode.enabled,
			devmodeAutoSave: preview.appConfigSummary.devmode.autoSave,
			aiChatMode: preview.appConfigSummary.aiChatMode,
			selectedModel: preview.resolvedModel.currentModel?.name ?? null,
			toolbarAppCount: preview.appConfigSummary.toolbarAppIds.length,
			visibleToolbarAppCount: preview.appStoreSummary.visibleHeaderIds.length,
			quickSendCount: preview.appConfigSummary.quickSendList.length,
			skippedVersionCount: preview.appConfigSummary.skippedVersions.length,
			serialBaudRate: preview.appConfigSummary.serialMonitor.baudRate,
			serialAutoScroll: preview.appConfigSummary.serialViewMode.autoScroll,
			serialInputHexMode: preview.appConfigSummary.serialInputMode.hexMode,
			serialConnectBaudRate: preview.serialConnect.baudRate,
			recentProjectCount: preview.recentProjects.length,
			recentModelProjectCount: preview.recentModels.length,
			onboardingCompleted: preview.onboarding.onboardingCompleted,
			blocklyOnboardingCompleted: preview.onboarding.blocklyOnboardingCompleted,
			ailyChatOnboardingCompleted: preview.onboarding.ailyChatOnboardingCompleted,
			previewSelectedLanguage: preview.previewConfig.selectedLanguage ?? preview.appConfigSummary.selectedLanguage,
			previewThemeMode: preview.previewConfig.theme === 'light' ? 'light' : 'dark',
			previewDevmodeEnabled: preview.previewConfig.devmode?.enabled ?? preview.appConfigSummary.devmode.enabled,
			previewDevmodeAutoSave: preview.previewConfig.devmode?.autoSave ?? preview.appConfigSummary.devmode.autoSave,
			previewSerialPort: preview.previewConfig.serialMonitor?.port ?? 'unset',
			previewAiChatMode: preview.previewConfig.aiChatMode ?? 'agent',
			previewToolbarAppCount: preview.previewConfig.toolbarAppIds?.length ?? 0,
			previewQuickSendCount: preview.previewConfig.quickSendList?.length ?? 0,
			previewSkippedVersionCount: preview.previewConfig.skippedVersions?.length ?? 0,
			defaultToolbarAppCount: preview.defaultAppStore.zones.header.length,
			mergedToolbarOrderCount: preview.mergedToolbarOrder.length,
			toggledToolbarAppCount: preview.toggledLayout.zones.header.length,
			resetToolbarAppCount: preview.resetLayout.zones.header.length,
			addedRecentProjectCount: preview.addedRecentProjects.recentlyProjects?.length ?? 0,
			removedRecentProjectCount: preview.removedRecentProjects.recentlyProjects?.length ?? 0,
			previewAilyChatOnboardingCompleted: preview.previewOnboarding.ailyChatOnboardingCompleted,
			addedRecentModelProjectCount: preview.addedRecentModelProjects.recentModelProjects?.length ?? 0,
			removedRecentModelProjectCount: preview.removedRecentModelProjects.recentModelProjects?.length ?? 0
		}
	}
}
