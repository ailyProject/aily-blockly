import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { AppShellComponent } from '@/layout/app-shell.component'
import { seedAppConfig } from '@/pages/home/data'

export interface SettingsSnapshot {
	selectedLanguage: string
	themeMode: string
	devmodeEnabled: boolean
	devmodeAutoSave: boolean
	aiChatMode: string
	selectedModel: string | null
	recentProjectCount: number
	recentModelProjectCount: number
	onboardingCompleted: boolean
	blocklyOnboardingCompleted: boolean
	ailyChatOnboardingCompleted: boolean
}

@Component({
	selector: 'settings-page',
	imports: [AppShellComponent, HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class SettingsPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly state = signal<SettingsSnapshot | null>(null)
	protected readonly loading = signal(true)
	protected readonly error = signal<string | null>(null)

	async ngOnInit() {
		await this.refresh()
	}

	protected async refresh() {
		this.loading.set(true)
		this.error.set(null)

		try {
			const [configSummary, recentProjects, recentModels, onboarding, resolvedModel] = await Promise.all([
				this.core.config.get.query({ config: seedAppConfig, fallbackLanguage: seedAppConfig.lang }),
				this.core.project.getRecentProjects.query({ config: seedAppConfig }),
				this.core.project.getRecentModelProjects.query({ config: seedAppConfig }),
				this.core.onboarding.getOnboarding.query({ config: seedAppConfig }),
				this.core.config.resolveModel.query({
					config: seedAppConfig,
					enabledModels: []
				})
			])

			this.state.set({
				selectedLanguage: configSummary.selectedLanguage,
				themeMode: configSummary.themeMode,
				devmodeEnabled: configSummary.devmodeEnabled,
				devmodeAutoSave: configSummary.devmode.autoSave,
				aiChatMode: configSummary.aiChatMode ?? 'agent',
				selectedModel: resolvedModel.currentModel?.name ?? seedAppConfig.aiChatModel?.name ?? null,
				recentProjectCount: recentProjects.length,
				recentModelProjectCount: recentModels.length,
				onboardingCompleted: onboarding.onboardingCompleted,
				blocklyOnboardingCompleted: onboarding.blocklyOnboardingCompleted,
				ailyChatOnboardingCompleted: onboarding.ailyChatOnboardingCompleted
			})
		} catch (error) {
			this.error.set((error as Error).message)
		} finally {
			this.loading.set(false)
		}
	}
}
