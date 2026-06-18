import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'

@Component({
	selector: 'home-page-status',
	imports: [HlmBadgeImports, HlmButtonImports],
	templateUrl: './home-page-status.component.html',
	styleUrl: './home-page-status.component.css'
})
export class HomePageStatusComponent {
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
}
