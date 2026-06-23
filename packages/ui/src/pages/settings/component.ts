import { Component, inject, OnInit, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { Router } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { AppShellComponent } from '@/layout/app-shell.component'
import { closeProjectInEditor } from '@/runtime/project-routing'
import { getCurrentProjectPath } from '@/runtime/project-session'
import { getCore } from '@/utils/core'
import { getDesktop, loadDesktopHostRuntimeInfo } from '@/utils/desktop'
import { config } from '@/workspace'

import type { DesktopHostRuntimeInfo } from '@desktop'
import type { SettingsSnapshot } from './types'

@Component({
	selector: 'settings-page',
	imports: [AppShellComponent, FormsModule, HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class SettingsPageComponent implements OnInit {
	private readonly core = getCore()
	private readonly router = inject(Router)
	private readonly desktop = getDesktop()

	protected readonly state = signal<SettingsSnapshot | null>(null)
	protected readonly loading = signal(true)
	protected readonly error = signal<string | null>(null)
	protected readonly closeBusy = signal(false)
	protected readonly saveBusy = signal(false)
	protected readonly saveMessage = signal<string | null>(null)
	protected readonly runtimeInfo = signal<DesktopHostRuntimeInfo | null>(null)
	protected readonly selectedLanguageDraft = signal('zh_CN')
	protected readonly themeModeDraft = signal<'dark' | 'light'>('dark')
	protected readonly regionKeyDraft = signal('cn')
	protected readonly resourceSourceKeyDraft = signal('auto')
	protected readonly themeOptions = [
		{ value: 'dark', label: 'Dark' },
		{ value: 'light', label: 'Light' }
	] as const
	protected readonly languageOptions = [
		{ value: 'zh_CN', label: 'Chinese (Simplified)' },
		{ value: 'en_US', label: 'English (US)' }
	] as const

	async ngOnInit() {
		if (this.desktop) {
			this.runtimeInfo.set(await loadDesktopHostRuntimeInfo(this.desktop).catch(() => null))
		}
		await this.refresh()
	}

	protected async refresh() {
		this.loading.set(true)
		this.error.set(null)

		try {
			const projectPath = getCurrentProjectPath()
			const [configSummary, recentProjects, recentModels, onboarding, resolvedModel, projectLifecycle] =
				await Promise.all([
					this.core.config.get.query({ config, fallbackLanguage: config.lang }),
					this.core.project.getRecentProjects.query({ config }),
					this.core.project.getRecentModelProjects.query({ config }),
					this.core.onboarding.getOnboarding.query({ config }),
					this.core.config.resolveModel.query({
						config,
						enabledModels: []
					}),
					projectPath ? this.core.project.getLifecycleStatus.query({ projectPath }) : Promise.resolve(null)
				])

			this.state.set({
				selectedLanguage: configSummary.selectedLanguage,
				themeMode: configSummary.themeMode,
				regionKey: configSummary.regionKey,
				resourceSourceKey: configSummary.resourceSourceKey,
				currentResourceSourceUrl: configSummary.currentResourceSource?.url || null,
				enabledRegionCount: configSummary.enabledRegions.length,
				resourceSourceCount: configSummary.resourceSources.length,
				enabledRegions: configSummary.enabledRegions,
				resourceSources: configSummary.resourceSources,
				devmodeEnabled: configSummary.devmodeEnabled,
				devmodeAutoSave: configSummary.devmode.autoSave,
				aiChatMode: configSummary.aiChatMode ?? 'agent',
				selectedModel: resolvedModel.currentModel?.name ?? config.aiChatModel?.name ?? null,
				recentProjectCount: recentProjects.length,
				recentModelProjectCount: recentModels.length,
				...(projectLifecycle
					? {
							projectLifecycle: {
								projectPath: projectLifecycle.projectPath,
								editorRoute: projectLifecycle.editorRoute,
								hasPackageJson: projectLifecycle.hasPackageJson,
								hasProjectDocument: projectLifecycle.hasProjectDocument,
								hasTempDocument: projectLifecycle.hasTempDocument,
								hasMutationLock: projectLifecycle.hasMutationLock,
								...(projectLifecycle.mutationLockStale ? { mutationLockStale: true } : {}),
								...(projectLifecycle.hasMutationLock && projectLifecycle.mutationLockOwner
									? { mutationLockOwner: projectLifecycle.mutationLockOwner }
									: {}),
								...(typeof projectLifecycle.mutationLockPid === 'number'
									? { mutationLockPid: projectLifecycle.mutationLockPid }
									: {}),
								hasOpenSessionLock: projectLifecycle.hasOpenSessionLock,
								...(projectLifecycle.openSessionLockStale ? { openSessionLockStale: true } : {}),
								...(projectLifecycle.hasOpenSessionLock && projectLifecycle.openSessionLockOwner
									? { openSessionLockOwner: projectLifecycle.openSessionLockOwner }
									: {}),
								...(typeof projectLifecycle.openSessionLockPid === 'number'
									? { openSessionLockPid: projectLifecycle.openSessionLockPid }
									: {}),
								recoveredFromTemp: projectLifecycle.recoveredFromTemp,
								...(projectLifecycle.sourceFilePath ? { sourceFilePath: projectLifecycle.sourceFilePath } : {}),
								...(projectLifecycle.parseError ? { parseError: projectLifecycle.parseError } : {}),
								...(projectLifecycle.boardPackageName ? { boardPackageName: projectLifecycle.boardPackageName } : {}),
								...(typeof projectLifecycle.boardPackageReady === 'boolean'
									? { boardPackageReady: projectLifecycle.boardPackageReady }
									: {}),
								declaredLibraryCount: projectLifecycle.declaredLibraryCount,
								readyLibraryCount: projectLifecycle.readyLibraryCount,
								missingLibraryCount: projectLifecycle.missingLibraryCount,
								...(projectLifecycle.codeHash ? { codeHash: projectLifecycle.codeHash } : {}),
								...(projectLifecycle.buildInfo?.lastBuildStatus
									? { buildStatus: projectLifecycle.buildInfo.lastBuildStatus }
									: {}),
								...(projectLifecycle.buildInfo?.lastBuildTime
									? { buildTime: projectLifecycle.buildInfo.lastBuildTime }
									: {}),
								...(typeof projectLifecycle.buildInfo?.lastBuildDuration === 'number'
									? { buildDuration: projectLifecycle.buildInfo.lastBuildDuration }
									: {})
							}
						}
					: {}),
				onboardingCompleted: onboarding.onboardingCompleted,
				blocklyOnboardingCompleted: onboarding.blocklyOnboardingCompleted,
				ailyChatOnboardingCompleted: onboarding.ailyChatOnboardingCompleted
			})
			this.selectedLanguageDraft.set(configSummary.selectedLanguage)
			this.themeModeDraft.set(configSummary.themeMode)
			this.regionKeyDraft.set(configSummary.regionKey)
			this.resourceSourceKeyDraft.set(configSummary.resourceSourceKey)
		} catch (error) {
			this.error.set((error as Error).message)
		} finally {
			this.loading.set(false)
		}
	}

	protected async saveConfig() {
		const runtimeInfo = this.runtimeInfo()
		if (!runtimeInfo?.available || !runtimeInfo.appDataPath) {
			this.saveMessage.set('Desktop runtime info is unavailable, so settings cannot be persisted here.')
			return
		}

		this.saveBusy.set(true)
		this.saveMessage.set(null)

		try {
			await this.core.config.updateStored.mutate({
				appDataPath: runtimeInfo.appDataPath,
				fallbackLanguage: config.lang,
				themeMode: this.themeModeDraft(),
				selectedLanguage: this.selectedLanguageDraft(),
				region: this.regionKeyDraft(),
				resourceSource: this.resourceSourceKeyDraft()
			})
			this.saveMessage.set('Settings saved to config.json.')
			await this.refresh()
		} catch (error) {
			this.saveMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			this.saveBusy.set(false)
		}
	}

	protected async closeProject() {
		this.closeBusy.set(true)
		try {
			await closeProjectInEditor(this.core, this.router)
		} finally {
			this.closeBusy.set(false)
		}
	}
}
