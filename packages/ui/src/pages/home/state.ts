import { signal } from '@angular/core'

import type { HomePageCoreState } from './types'

export const createHomePageState = () => ({
	desktopBackendReachable: signal(false),
	desktopBackendManaged: signal(false),
	desktopBackendBaseUrl: signal('http://127.0.0.1:3072'),
	desktopBackendError: signal<string | null>(null),
	hardwareCategories: signal<Array<{ name: string; count: number }>>([]),
	boardValidationText: signal('pending'),
	libraryValidationText: signal('pending'),
	enabledModelCount: signal(0),
	securitySummary: signal<Array<{ name: string; enabled: boolean }>>([]),
	appLanguage: signal('unknown'),
	appThemeMode: signal('dark'),
	devmodeEnabled: signal(false),
	devmodeAutoSave: signal(true),
	appAiChatMode: signal('agent'),
	appSelectedModel: signal('none'),
	toolbarAppCount: signal(0),
	visibleToolbarAppCount: signal(0),
	quickSendCount: signal(0),
	skippedVersionCount: signal(0),
	serialBaudRate: signal('9600'),
	serialAutoScroll: signal(true),
	serialInputHexMode: signal(false),
	serialConnectBaudRate: signal(9600),
	recentProjectCount: signal(0),
	recentModelProjectCount: signal(0),
	onboardingCompleted: signal(false),
	blocklyOnboardingCompleted: signal(false),
	ailyChatOnboardingCompleted: signal(false),
	previewSelectedLanguage: signal('unknown'),
	previewThemeMode: signal('dark'),
	previewDevmodeEnabled: signal(false),
	previewDevmodeAutoSave: signal(true),
	previewSerialPort: signal('unset'),
	previewAiChatMode: signal('agent'),
	previewToolbarAppCount: signal(0),
	previewQuickSendCount: signal(0),
	previewSkippedVersionCount: signal(0),
	defaultToolbarAppCount: signal(0),
	mergedToolbarOrderCount: signal(0),
	toggledToolbarAppCount: signal(0),
	resetToolbarAppCount: signal(0),
	addedRecentProjectCount: signal(0),
	removedRecentProjectCount: signal(0),
	previewAilyChatOnboardingCompleted: signal(false),
	addedRecentModelProjectCount: signal(0),
	removedRecentModelProjectCount: signal(0)
})

export const applyHomePageCoreState = (target: ReturnType<typeof createHomePageState>, state: HomePageCoreState) => {
	target.hardwareCategories.set(state.architectureCategories)
	target.boardValidationText.set(
		state.boardValidation.exists
			? `${state.boardValidation.fuzzyMatch ? 'fuzzy' : 'exact'} -> ${state.boardValidation.matchedName}`
			: 'not found'
	)
	target.libraryValidationText.set(
		state.libraryValidation.exists
			? `${state.libraryValidation.fuzzyMatch ? 'fuzzy' : 'exact'} -> ${state.libraryValidation.matchedName}`
			: 'not found'
	)
	target.enabledModelCount.set(state.enabledModelCount)
	target.securitySummary.set(state.securityOptions)
	target.appLanguage.set(state.configSummary.selectedLanguage)
	target.appThemeMode.set(state.configSummary.themeMode)
	target.devmodeEnabled.set(state.configSummary.devmodeEnabled)
	target.devmodeAutoSave.set(state.configSummary.devmodeAutoSave)
	target.appAiChatMode.set(state.configSummary.aiChatMode)
	target.appSelectedModel.set(state.configSummary.selectedModel ?? 'none')
	target.recentModelProjectCount.set(state.configSummary.recentModelProjectCount)
	target.toolbarAppCount.set(state.configSummary.toolbarAppCount)
	target.visibleToolbarAppCount.set(state.configSummary.visibleToolbarAppCount)
	target.quickSendCount.set(state.configSummary.quickSendCount)
	target.skippedVersionCount.set(state.configSummary.skippedVersionCount)
	target.serialBaudRate.set(state.configSummary.serialBaudRate)
	target.serialAutoScroll.set(state.configSummary.serialAutoScroll)
	target.serialInputHexMode.set(state.configSummary.serialInputHexMode)
	target.serialConnectBaudRate.set(state.configSummary.serialConnectBaudRate)
	target.recentProjectCount.set(state.configSummary.recentProjectCount)
	target.onboardingCompleted.set(state.configSummary.onboardingCompleted)
	target.blocklyOnboardingCompleted.set(state.configSummary.blocklyOnboardingCompleted)
	target.ailyChatOnboardingCompleted.set(state.configSummary.ailyChatOnboardingCompleted)
	target.previewSelectedLanguage.set(state.configSummary.previewSelectedLanguage)
	target.previewThemeMode.set(state.configSummary.previewThemeMode)
	target.previewDevmodeEnabled.set(state.configSummary.previewDevmodeEnabled)
	target.previewDevmodeAutoSave.set(state.configSummary.previewDevmodeAutoSave)
	target.previewSerialPort.set(state.configSummary.previewSerialPort)
	target.previewAiChatMode.set(state.configSummary.previewAiChatMode)
	target.previewToolbarAppCount.set(state.configSummary.previewToolbarAppCount)
	target.previewQuickSendCount.set(state.configSummary.previewQuickSendCount)
	target.previewSkippedVersionCount.set(state.configSummary.previewSkippedVersionCount)
	target.defaultToolbarAppCount.set(state.configSummary.defaultToolbarAppCount)
	target.mergedToolbarOrderCount.set(state.configSummary.mergedToolbarOrderCount)
	target.toggledToolbarAppCount.set(state.configSummary.toggledToolbarAppCount)
	target.resetToolbarAppCount.set(state.configSummary.resetToolbarAppCount)
	target.addedRecentProjectCount.set(state.configSummary.addedRecentProjectCount)
	target.removedRecentProjectCount.set(state.configSummary.removedRecentProjectCount)
	target.previewAilyChatOnboardingCompleted.set(state.configSummary.previewAilyChatOnboardingCompleted)
	target.addedRecentModelProjectCount.set(state.configSummary.addedRecentModelProjectCount)
	target.removedRecentModelProjectCount.set(state.configSummary.removedRecentModelProjectCount)
}
