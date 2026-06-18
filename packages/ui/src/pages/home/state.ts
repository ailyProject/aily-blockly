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
	target.appLanguage.set(state.appConfigSummary.selectedLanguage)
	target.appThemeMode.set(state.appConfigSummary.themeMode)
	target.devmodeEnabled.set(state.appConfigSummary.devmodeEnabled)
	target.devmodeAutoSave.set(state.appConfigSummary.devmodeAutoSave)
	target.appAiChatMode.set(state.appConfigSummary.aiChatMode)
	target.appSelectedModel.set(state.appConfigSummary.selectedModel ?? 'none')
	target.recentModelProjectCount.set(state.appConfigSummary.recentModelProjectCount)
	target.toolbarAppCount.set(state.appConfigSummary.toolbarAppCount)
	target.visibleToolbarAppCount.set(state.appConfigSummary.visibleToolbarAppCount)
	target.quickSendCount.set(state.appConfigSummary.quickSendCount)
	target.skippedVersionCount.set(state.appConfigSummary.skippedVersionCount)
	target.serialBaudRate.set(state.appConfigSummary.serialBaudRate)
	target.serialAutoScroll.set(state.appConfigSummary.serialAutoScroll)
	target.serialInputHexMode.set(state.appConfigSummary.serialInputHexMode)
	target.serialConnectBaudRate.set(state.appConfigSummary.serialConnectBaudRate)
	target.recentProjectCount.set(state.appConfigSummary.recentProjectCount)
	target.onboardingCompleted.set(state.appConfigSummary.onboardingCompleted)
	target.blocklyOnboardingCompleted.set(state.appConfigSummary.blocklyOnboardingCompleted)
	target.ailyChatOnboardingCompleted.set(state.appConfigSummary.ailyChatOnboardingCompleted)
	target.previewSelectedLanguage.set(state.appConfigSummary.previewSelectedLanguage)
	target.previewThemeMode.set(state.appConfigSummary.previewThemeMode)
	target.previewDevmodeEnabled.set(state.appConfigSummary.previewDevmodeEnabled)
	target.previewDevmodeAutoSave.set(state.appConfigSummary.previewDevmodeAutoSave)
	target.previewSerialPort.set(state.appConfigSummary.previewSerialPort)
	target.previewAiChatMode.set(state.appConfigSummary.previewAiChatMode)
	target.previewToolbarAppCount.set(state.appConfigSummary.previewToolbarAppCount)
	target.previewQuickSendCount.set(state.appConfigSummary.previewQuickSendCount)
	target.previewSkippedVersionCount.set(state.appConfigSummary.previewSkippedVersionCount)
	target.defaultToolbarAppCount.set(state.appConfigSummary.defaultToolbarAppCount)
	target.mergedToolbarOrderCount.set(state.appConfigSummary.mergedToolbarOrderCount)
	target.toggledToolbarAppCount.set(state.appConfigSummary.toggledToolbarAppCount)
	target.resetToolbarAppCount.set(state.appConfigSummary.resetToolbarAppCount)
	target.addedRecentProjectCount.set(state.appConfigSummary.addedRecentProjectCount)
	target.removedRecentProjectCount.set(state.appConfigSummary.removedRecentProjectCount)
	target.previewAilyChatOnboardingCompleted.set(state.appConfigSummary.previewAilyChatOnboardingCompleted)
	target.addedRecentModelProjectCount.set(state.appConfigSummary.addedRecentModelProjectCount)
	target.removedRecentModelProjectCount.set(state.appConfigSummary.removedRecentModelProjectCount)
}
