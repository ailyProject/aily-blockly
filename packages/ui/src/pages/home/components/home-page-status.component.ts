import { Component, computed, input, output } from '@angular/core'
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

	protected readonly coreRouteRows = computed(() => [
		{ label: 'board validate', value: this.boardValidationText() },
		{ label: 'library validate', value: this.libraryValidationText() }
	])

	protected readonly configRows = computed(() => [
		{ label: 'language', value: this.appLanguage() },
		{ label: 'theme', value: this.appThemeMode() },
		{ label: 'dev enabled', value: this.devmodeEnabled() ? 'on' : 'off' },
		{ label: 'dev autoSave', value: this.devmodeAutoSave() ? 'on' : 'off' },
		{ label: 'ai mode', value: this.appAiChatMode() },
		{ label: 'selected model', value: this.appSelectedModel() },
		{ label: 'recent model projects', value: String(this.recentModelProjectCount()) },
		{ label: 'toolbar apps', value: String(this.toolbarAppCount()) },
		{ label: 'visible toolbar apps', value: String(this.visibleToolbarAppCount()) },
		{ label: 'quick send presets', value: String(this.quickSendCount()) },
		{ label: 'skipped versions', value: String(this.skippedVersionCount()) },
		{ label: 'serial baud', value: this.serialBaudRate() },
		{ label: 'serial autoscroll', value: this.serialAutoScroll() ? 'on' : 'off' },
		{ label: 'serial hex input', value: this.serialInputHexMode() ? 'on' : 'off' },
		{ label: 'serial connect baud', value: String(this.serialConnectBaudRate()) },
		{ label: 'recent projects', value: String(this.recentProjectCount()) },
		{ label: 'guide onboarding', value: this.onboardingCompleted() ? 'done' : 'todo' },
		{ label: 'blockly onboarding', value: this.blocklyOnboardingCompleted() ? 'done' : 'todo' },
		{ label: 'chat onboarding', value: this.ailyChatOnboardingCompleted() ? 'done' : 'todo' }
	])

	protected readonly previewRows = computed(() => [
		{ label: 'preview mode', value: this.previewAiChatMode() },
		{ label: 'preview language', value: this.previewSelectedLanguage() },
		{ label: 'preview theme', value: this.previewThemeMode() },
		{ label: 'preview dev enabled', value: this.previewDevmodeEnabled() ? 'on' : 'off' },
		{ label: 'preview dev autoSave', value: this.previewDevmodeAutoSave() ? 'on' : 'off' },
		{ label: 'preview serial port', value: this.previewSerialPort() },
		{ label: 'preview toolbar apps', value: String(this.previewToolbarAppCount()) },
		{ label: 'preview quick sends', value: String(this.previewQuickSendCount()) },
		{ label: 'preview skipped versions', value: String(this.previewSkippedVersionCount()) },
		{ label: 'default toolbar apps', value: String(this.defaultToolbarAppCount()) },
		{ label: 'merged toolbar order', value: String(this.mergedToolbarOrderCount()) },
		{ label: 'toggled toolbar apps', value: String(this.toggledToolbarAppCount()) },
		{ label: 'reset toolbar apps', value: String(this.resetToolbarAppCount()) },
		{ label: 'added recent projects', value: String(this.addedRecentProjectCount()) },
		{ label: 'removed recent projects', value: String(this.removedRecentProjectCount()) },
		{ label: 'added recent models', value: String(this.addedRecentModelProjectCount()) },
		{ label: 'removed recent models', value: String(this.removedRecentModelProjectCount()) },
		{ label: 'preview chat onboarding', value: this.previewAilyChatOnboardingCompleted() ? 'done' : 'todo' }
	])
}
