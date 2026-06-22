import { Component, OnInit, signal } from '@angular/core'
import { HlmAlertImports } from 'spartan/alert'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'

import { APP_ICON_IMPORTS, APP_ICON_PROVIDERS } from '@/components/ui/icon/app-icons'
import { AppShellComponent } from '@/layout/app-shell.component'
import { HomeInspectorRailComponent } from '@/pages/home/components/inspector-rail.component'
import { HomeNavigationRailComponent } from '@/pages/home/components/navigation-rail.component'
import { HomeWorkspaceCenterComponent } from '@/pages/home/components/workspace-center.component'
import { bottomTabItems, inspectorCards, navigationCards } from '@/pages/home/data'
import { createHomePageState } from '@/pages/home/state'
import { boardColumns, boardRows } from '@/pages/home/table-data'
import { createHomePageActions } from '@/pages/home/utils/actions'
import { getThemeMode } from '@/runtime/theme'
import { getCore } from '@/utils/core'
import { getDesktop } from '@/utils/desktop'

@Component({
	selector: 'home-page',
	imports: [
		AppShellComponent,
		HlmBadgeImports,
		HlmButtonImports,
		HomeInspectorRailComponent,
		HomeNavigationRailComponent,
		HomeWorkspaceCenterComponent,
		...APP_ICON_IMPORTS
	],
	providers: [...APP_ICON_PROVIDERS],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class HomePageComponent implements OnInit {
	private readonly core = getCore()
	private readonly desktop = getDesktop()
	private readonly pageState = createHomePageState()
	protected readonly bottomTab = signal('logs')
	protected readonly themeMode = signal(getThemeMode())
	private readonly actions = createHomePageActions({
		core: this.core,
		desktop: this.desktop,
		pageState: this.pageState,
		themeMode: this.themeMode
	})

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
		await this.actions.refreshDesktopBackendStatus()
		if (this.desktop && !this.desktopBackendReachable()) await this.actions.ensureDesktopBackendStarted()
		await this.actions.refreshCoreDerivedState()
	}

	protected readonly refreshDesktopBackendStatus = () => this.actions.refreshDesktopBackendStatus()
	protected readonly ensureDesktopBackendStarted = () => this.actions.ensureDesktopBackendStarted()
	protected readonly refreshCoreDerivedState = () => this.actions.refreshCoreDerivedState()
	protected readonly handleThemeToggle = () => this.actions.handleThemeToggle()
	protected readonly useDarkMode = () => this.actions.useDarkMode()

	protected get themeActionLabel() {
		return this.actions.getThemeActionLabel()
	}
}
