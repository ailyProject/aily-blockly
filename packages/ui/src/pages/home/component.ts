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
import { applyHomePageCoreState, createHomePageState } from '@/pages/home/state'
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
	private readonly pageState = createHomePageState()

	protected readonly bottomTab = signal('logs')
	protected readonly themeMode = signal(getThemeMode())
	protected readonly tabItems = bottomTabItems
	protected readonly navigationCards = navigationCards
	protected readonly inspectorCards = inspectorCards
	protected readonly boardColumns = boardColumns
	protected readonly boardRows = boardRows
	protected readonly desktopBackendReachable = this.pageState.desktopBackendReachable
	protected readonly desktopBackendManaged = this.pageState.desktopBackendManaged
	protected readonly desktopBackendBaseUrl = this.pageState.desktopBackendBaseUrl
	protected readonly desktopBackendError = this.pageState.desktopBackendError
	protected readonly hardwareCategories = this.pageState.hardwareCategories
	protected readonly boardValidationText = this.pageState.boardValidationText
	protected readonly libraryValidationText = this.pageState.libraryValidationText
	protected readonly enabledModelCount = this.pageState.enabledModelCount
	protected readonly securitySummary = this.pageState.securitySummary
	protected readonly appLanguage = this.pageState.appLanguage
	protected readonly appThemeMode = this.pageState.appThemeMode
	protected readonly devmodeEnabled = this.pageState.devmodeEnabled
	protected readonly devmodeAutoSave = this.pageState.devmodeAutoSave
	protected readonly appAiChatMode = this.pageState.appAiChatMode
	protected readonly appSelectedModel = this.pageState.appSelectedModel
	protected readonly toolbarAppCount = this.pageState.toolbarAppCount
	protected readonly visibleToolbarAppCount = this.pageState.visibleToolbarAppCount
	protected readonly quickSendCount = this.pageState.quickSendCount
	protected readonly skippedVersionCount = this.pageState.skippedVersionCount
	protected readonly serialBaudRate = this.pageState.serialBaudRate
	protected readonly serialAutoScroll = this.pageState.serialAutoScroll
	protected readonly serialInputHexMode = this.pageState.serialInputHexMode
	protected readonly serialConnectBaudRate = this.pageState.serialConnectBaudRate
	protected readonly recentProjectCount = this.pageState.recentProjectCount
	protected readonly recentModelProjectCount = this.pageState.recentModelProjectCount
	protected readonly onboardingCompleted = this.pageState.onboardingCompleted
	protected readonly blocklyOnboardingCompleted = this.pageState.blocklyOnboardingCompleted
	protected readonly ailyChatOnboardingCompleted = this.pageState.ailyChatOnboardingCompleted
	protected readonly previewSelectedLanguage = this.pageState.previewSelectedLanguage
	protected readonly previewThemeMode = this.pageState.previewThemeMode
	protected readonly previewDevmodeEnabled = this.pageState.previewDevmodeEnabled
	protected readonly previewDevmodeAutoSave = this.pageState.previewDevmodeAutoSave
	protected readonly previewSerialPort = this.pageState.previewSerialPort
	protected readonly previewAiChatMode = this.pageState.previewAiChatMode
	protected readonly previewToolbarAppCount = this.pageState.previewToolbarAppCount
	protected readonly previewQuickSendCount = this.pageState.previewQuickSendCount
	protected readonly previewSkippedVersionCount = this.pageState.previewSkippedVersionCount
	protected readonly defaultToolbarAppCount = this.pageState.defaultToolbarAppCount
	protected readonly mergedToolbarOrderCount = this.pageState.mergedToolbarOrderCount
	protected readonly toggledToolbarAppCount = this.pageState.toggledToolbarAppCount
	protected readonly resetToolbarAppCount = this.pageState.resetToolbarAppCount
	protected readonly addedRecentProjectCount = this.pageState.addedRecentProjectCount
	protected readonly removedRecentProjectCount = this.pageState.removedRecentProjectCount
	protected readonly previewAilyChatOnboardingCompleted = this.pageState.previewAilyChatOnboardingCompleted
	protected readonly addedRecentModelProjectCount = this.pageState.addedRecentModelProjectCount
	protected readonly removedRecentModelProjectCount = this.pageState.removedRecentModelProjectCount

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
			applyHomePageCoreState(this.pageState, await loadHomePageCoreState(this.core))
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
