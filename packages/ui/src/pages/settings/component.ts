import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { AppShellComponent } from '@/layout/app-shell.component'
import { config } from '@/workspace'

import type { SettingsSnapshot } from './types'

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
				this.core.config.get.query({ config, fallbackLanguage: config.lang }),
				this.core.project.getRecentProjects.query({ config }),
				this.core.project.getRecentModelProjects.query({ config }),
				this.core.onboarding.getOnboarding.query({ config }),
				this.core.config.resolveModel.query({
					config,
					enabledModels: []
				})
			])

			this.state.set({
				selectedLanguage: configSummary.selectedLanguage,
				themeMode: configSummary.themeMode,
				devmodeEnabled: configSummary.devmodeEnabled,
				devmodeAutoSave: configSummary.devmode.autoSave,
				aiChatMode: configSummary.aiChatMode ?? 'agent',
				selectedModel: resolvedModel.currentModel?.name ?? config.aiChatModel?.name ?? null,
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
