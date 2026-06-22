import { Component, input, output } from '@angular/core'
import { HlmAlertImports } from 'spartan/alert'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmSeparatorImports } from 'spartan/separator'
import { HlmTabsImports } from 'spartan/tabs'

import { DataTableImports } from '@/components/ui/data-table/src'
import { APP_ICON_IMPORTS } from '@/components/ui/icon/app-icons'
import { HomePageStatusComponent } from '@/pages/home/components/home-page-status.component'

import type { DataTableColumn } from '@/components/ui/data-table/src'
import type { HomeBoardRow } from '@/pages/home/types'

/**
 * 首页中间工作区。
 */
@Component({
	selector: 'home-workspace-center',
	imports: [
		DataTableImports,
		HlmAlertImports,
		HlmBadgeImports,
		HlmButtonImports,
		HlmCardImports,
		HomePageStatusComponent,
		HlmSeparatorImports,
		HlmTabsImports,
		...APP_ICON_IMPORTS
	],
	templateUrl: './workspace-center.component.html',
	styleUrl: './workspace-center.component.css'
})
export class HomeWorkspaceCenterComponent {
	readonly bottomTab = input.required<string>()
	readonly tabItems = input.required<Array<{ id: string; title: string; items: Array<string> }>>()
	readonly boardColumns = input.required<Array<DataTableColumn<HomeBoardRow>>>()
	readonly boardRows = input.required<Array<HomeBoardRow>>()
	readonly desktopBackendBaseUrl = input.required<string>()
	readonly desktopBackendReachable = input.required<boolean>()
	readonly desktopBackendManaged = input.required<boolean>()
	readonly desktopBackendError = input<string | null>(null)
	readonly enabledModelCount = input.required<number>()
	readonly boardValidationText = input.required<string>()
	readonly libraryValidationText = input.required<string>()
	readonly hardwareCategories = input.required<Array<{ name: string; count: number }>>()
	readonly securitySummary = input.required<Array<{ name: string; enabled: boolean }>>()
	readonly appLanguage = input.required<string>()
	readonly appThemeMode = input.required<string>()
	readonly devmodeEnabled = input.required<boolean>()
	readonly devmodeAutoSave = input.required<boolean>()
	readonly appAiChatMode = input.required<string>()
	readonly appSelectedModel = input.required<string>()
	readonly recentModelProjectCount = input.required<number>()
	readonly toolbarAppCount = input.required<number>()
	readonly visibleToolbarAppCount = input.required<number>()
	readonly quickSendCount = input.required<number>()
	readonly skippedVersionCount = input.required<number>()
	readonly serialBaudRate = input.required<string>()
	readonly serialAutoScroll = input.required<boolean>()
	readonly serialInputHexMode = input.required<boolean>()
	readonly serialConnectBaudRate = input.required<number>()
	readonly recentProjectCount = input.required<number>()
	readonly onboardingCompleted = input.required<boolean>()
	readonly blocklyOnboardingCompleted = input.required<boolean>()
	readonly ailyChatOnboardingCompleted = input.required<boolean>()
	readonly previewSelectedLanguage = input.required<string>()
	readonly previewThemeMode = input.required<string>()
	readonly previewDevmodeEnabled = input.required<boolean>()
	readonly previewDevmodeAutoSave = input.required<boolean>()
	readonly previewSerialPort = input.required<string>()
	readonly previewAiChatMode = input.required<string>()
	readonly previewToolbarAppCount = input.required<number>()
	readonly previewQuickSendCount = input.required<number>()
	readonly previewSkippedVersionCount = input.required<number>()
	readonly defaultToolbarAppCount = input.required<number>()
	readonly mergedToolbarOrderCount = input.required<number>()
	readonly toggledToolbarAppCount = input.required<number>()
	readonly resetToolbarAppCount = input.required<number>()
	readonly addedRecentProjectCount = input.required<number>()
	readonly removedRecentProjectCount = input.required<number>()
	readonly previewAilyChatOnboardingCompleted = input.required<boolean>()
	readonly addedRecentModelProjectCount = input.required<number>()
	readonly removedRecentModelProjectCount = input.required<number>()
	readonly refresh = output<void>()
	readonly startBackend = output<void>()
	readonly useDarkMode = output<void>()
	readonly bottomTabChange = output<string>()
}
