import { Component, OnInit, signal } from '@angular/core'
import { HlmAlertImports } from 'spartan/alert'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'
import { HlmSeparatorImports } from 'spartan/separator'
import { HlmTabsImports } from 'spartan/tabs'

import { DataTableImports } from '@/components/ui/data-table/src'
import { APP_ICON_IMPORTS, APP_ICON_PROVIDERS } from '@/components/ui/icon/app-icons'
import { injectCore } from '@/core-service'
import { injectDesktop } from '@/desktop-service'
import { AppShellComponent } from '@/layout/app-shell.component'
import { HomePageStatusComponent } from '@/pages/home/components/home-page-status.component'
import { bottomTabItems, inspectorCards, navigationCards } from '@/pages/home/data'
import { loadHomePageCoreState } from '@/pages/home/runtime'
import { boardColumns, boardRows } from '@/pages/home/table-data'
import { applyThemeMode, getThemeMode, toggleThemeMode } from '@/runtime/theme'

@Component({
	selector: 'home-page',
	imports: [
		AppShellComponent,
		HlmAlertImports,
		HlmBadgeImports,
		HlmButtonImports,
		HlmCardImports,
		DataTableImports,
		HomePageStatusComponent,
		HlmInputImports,
		HlmSeparatorImports,
		HlmTabsImports,
		...APP_ICON_IMPORTS
	],
	providers: [...APP_ICON_PROVIDERS],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class HomePageComponent implements OnInit {
	private readonly core = injectCore()
	private readonly desktop = injectDesktop()

	protected readonly bottomTab = signal('logs')
	protected readonly themeMode = signal(getThemeMode())
	protected readonly tabItems = bottomTabItems
	protected readonly navigationCards = navigationCards
	protected readonly inspectorCards = inspectorCards
	protected readonly boardColumns = boardColumns
	protected readonly boardRows = boardRows
	protected readonly desktopBackendReachable = signal(false)
	protected readonly desktopBackendManaged = signal(false)
	protected readonly desktopBackendBaseUrl = signal('http://127.0.0.1:3072')
	protected readonly desktopBackendError = signal<string | null>(null)
	protected readonly hardwareCategories = signal<Array<{ name: string; count: number }>>([])
	protected readonly boardValidationText = signal('pending')
	protected readonly libraryValidationText = signal('pending')
	protected readonly enabledModelCount = signal(0)
	protected readonly securitySummary = signal<Array<{ name: string; enabled: boolean }>>([])
	protected readonly appLanguage = signal('unknown')
	protected readonly appThemeMode = signal('dark')
	protected readonly devmodeEnabled = signal(false)
	protected readonly devmodeAutoSave = signal(true)
	protected readonly appAiChatMode = signal('agent')
	protected readonly appSelectedModel = signal('none')
	protected readonly toolbarAppCount = signal(0)
	protected readonly visibleToolbarAppCount = signal(0)
	protected readonly quickSendCount = signal(0)
	protected readonly skippedVersionCount = signal(0)
	protected readonly serialBaudRate = signal('9600')
	protected readonly serialAutoScroll = signal(true)
	protected readonly serialInputHexMode = signal(false)
	protected readonly serialConnectBaudRate = signal(9600)
	protected readonly recentProjectCount = signal(0)
	protected readonly recentModelProjectCount = signal(0)
	protected readonly onboardingCompleted = signal(false)
	protected readonly blocklyOnboardingCompleted = signal(false)
	protected readonly ailyChatOnboardingCompleted = signal(false)
	protected readonly previewSelectedLanguage = signal('unknown')
	protected readonly previewThemeMode = signal('dark')
	protected readonly previewDevmodeEnabled = signal(false)
	protected readonly previewDevmodeAutoSave = signal(true)
	protected readonly previewSerialPort = signal('unset')
	protected readonly previewAiChatMode = signal('agent')
	protected readonly previewToolbarAppCount = signal(0)
	protected readonly previewQuickSendCount = signal(0)
	protected readonly previewSkippedVersionCount = signal(0)
	protected readonly defaultToolbarAppCount = signal(0)
	protected readonly mergedToolbarOrderCount = signal(0)
	protected readonly toggledToolbarAppCount = signal(0)
	protected readonly resetToolbarAppCount = signal(0)
	protected readonly addedRecentProjectCount = signal(0)
	protected readonly removedRecentProjectCount = signal(0)
	protected readonly previewAilyChatOnboardingCompleted = signal(false)
	protected readonly addedRecentModelProjectCount = signal(0)
	protected readonly removedRecentModelProjectCount = signal(0)

	async ngOnInit() {
		await this.refreshDesktopBackendStatus()
		if (this.desktop && !this.desktopBackendReachable()) await this.ensureDesktopBackendStarted()
		await this.refreshCoreDerivedState()
	}

	protected async refreshDesktopBackendStatus() {
		if (!this.desktop) {
			this.desktopBackendManaged.set(false)
			this.desktopBackendReachable.set(false)
			return
		}

		try {
			const status = await this.desktop.core.getCoreStatus.query()
			this.desktopBackendManaged.set(status.managed)
			this.desktopBackendReachable.set(status.reachable)
			this.desktopBackendBaseUrl.set(status.address.baseUrl)
			this.desktopBackendError.set(null)
		} catch (error) {
			this.desktopBackendError.set((error as Error).message)
		}
	}

	protected async ensureDesktopBackendStarted() {
		if (!this.desktop) return

		try {
			const status = await this.desktop.core.ensureCoreStarted.query()
			this.desktopBackendManaged.set(status.managed)
			this.desktopBackendReachable.set(status.reachable)
			this.desktopBackendBaseUrl.set(status.address.baseUrl)
			this.desktopBackendError.set(null)
			await this.refreshCoreDerivedState()
		} catch (error) {
			this.desktopBackendError.set((error as Error).message)
		}
	}

	protected async refreshCoreDerivedState() {
		try {
			const state = await loadHomePageCoreState(this.core)
			this.hardwareCategories.set(state.architectureCategories)
			this.boardValidationText.set(
				state.boardValidation.exists
					? `${state.boardValidation.fuzzyMatch ? 'fuzzy' : 'exact'} -> ${state.boardValidation.matchedName}`
					: 'not found'
			)
			this.libraryValidationText.set(
				state.libraryValidation.exists
					? `${state.libraryValidation.fuzzyMatch ? 'fuzzy' : 'exact'} -> ${state.libraryValidation.matchedName}`
					: 'not found'
			)
			this.enabledModelCount.set(state.enabledModelCount)
			this.securitySummary.set(state.securityOptions)
			this.appLanguage.set(state.appConfigSummary.selectedLanguage)
			this.appThemeMode.set(state.appConfigSummary.themeMode)
			this.devmodeEnabled.set(state.appConfigSummary.devmodeEnabled)
			this.devmodeAutoSave.set(state.appConfigSummary.devmodeAutoSave)
			this.appAiChatMode.set(state.appConfigSummary.aiChatMode)
			this.appSelectedModel.set(state.appConfigSummary.selectedModel ?? 'none')
			this.recentModelProjectCount.set(state.appConfigSummary.recentModelProjectCount)
			this.toolbarAppCount.set(state.appConfigSummary.toolbarAppCount)
			this.visibleToolbarAppCount.set(state.appConfigSummary.visibleToolbarAppCount)
			this.quickSendCount.set(state.appConfigSummary.quickSendCount)
			this.skippedVersionCount.set(state.appConfigSummary.skippedVersionCount)
			this.serialBaudRate.set(state.appConfigSummary.serialBaudRate)
			this.serialAutoScroll.set(state.appConfigSummary.serialAutoScroll)
			this.serialInputHexMode.set(state.appConfigSummary.serialInputHexMode)
			this.serialConnectBaudRate.set(state.appConfigSummary.serialConnectBaudRate)
			this.recentProjectCount.set(state.appConfigSummary.recentProjectCount)
			this.onboardingCompleted.set(state.appConfigSummary.onboardingCompleted)
			this.blocklyOnboardingCompleted.set(state.appConfigSummary.blocklyOnboardingCompleted)
			this.ailyChatOnboardingCompleted.set(state.appConfigSummary.ailyChatOnboardingCompleted)
			this.previewSelectedLanguage.set(state.appConfigSummary.previewSelectedLanguage)
			this.previewThemeMode.set(state.appConfigSummary.previewThemeMode)
			this.previewDevmodeEnabled.set(state.appConfigSummary.previewDevmodeEnabled)
			this.previewDevmodeAutoSave.set(state.appConfigSummary.previewDevmodeAutoSave)
			this.previewSerialPort.set(state.appConfigSummary.previewSerialPort)
			this.previewAiChatMode.set(state.appConfigSummary.previewAiChatMode)
			this.previewToolbarAppCount.set(state.appConfigSummary.previewToolbarAppCount)
			this.previewQuickSendCount.set(state.appConfigSummary.previewQuickSendCount)
			this.previewSkippedVersionCount.set(state.appConfigSummary.previewSkippedVersionCount)
			this.defaultToolbarAppCount.set(state.appConfigSummary.defaultToolbarAppCount)
			this.mergedToolbarOrderCount.set(state.appConfigSummary.mergedToolbarOrderCount)
			this.toggledToolbarAppCount.set(state.appConfigSummary.toggledToolbarAppCount)
			this.resetToolbarAppCount.set(state.appConfigSummary.resetToolbarAppCount)
			this.addedRecentProjectCount.set(state.appConfigSummary.addedRecentProjectCount)
			this.removedRecentProjectCount.set(state.appConfigSummary.removedRecentProjectCount)
			this.previewAilyChatOnboardingCompleted.set(state.appConfigSummary.previewAilyChatOnboardingCompleted)
			this.addedRecentModelProjectCount.set(state.appConfigSummary.addedRecentModelProjectCount)
			this.removedRecentModelProjectCount.set(state.appConfigSummary.removedRecentModelProjectCount)
		} catch (error) {
			this.boardValidationText.set(`core route error: ${(error as Error).message}`)
			this.libraryValidationText.set('core route error')
		}
	}

	protected handleThemeToggle() {
		this.themeMode.set(toggleThemeMode())
	}

	protected useDarkMode() {
		this.themeMode.set(applyThemeMode('dark'))
	}

	protected get themeActionLabel() {
		return this.themeMode() === 'dark' ? 'Switch to light' : 'Switch to dark'
	}
}
