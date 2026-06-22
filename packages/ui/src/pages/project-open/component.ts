import { Component, inject, OnInit, signal } from '@angular/core'
import { Router } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { AppShellComponent } from '@/layout/app-shell.component'
import { getCore } from '@/utils/core'
import { getDesktop, loadDesktopHostRuntimeInfo, selectDesktopProjectPath } from '@/utils/desktop'
import { config } from '@/workspace'

import { createProjectOpenActions } from './component.actions'
import { loadProjectOpenLifecycle, loadProjectOpenRecentProjects, loadProjectOpenRuntimeInfo } from './runtime'

import type { RecentlyProjectEntry } from 'shared'
import type { ProjectOpenSessionConflict } from './component.actions.types'

@Component({
	selector: 'project-open-page',
	imports: [AppShellComponent, HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ProjectOpenPageComponent implements OnInit {
	private readonly core = getCore()
	private readonly desktop = getDesktop()
	private readonly router = inject(Router)

	protected readonly runtimeInfo = signal<Awaited<ReturnType<typeof loadDesktopHostRuntimeInfo>> | null>(null)
	protected readonly recentProjects = signal<Array<RecentlyProjectEntry>>([])
	protected readonly selectedPath = signal('')
	protected readonly resolvedProjectPath = signal('')
	protected readonly previewLifecycle = signal<Awaited<ReturnType<typeof loadProjectOpenLifecycle>> | null>(null)
	protected readonly statusMessage = signal<string | null>(null)
	protected readonly loading = signal(true)
	protected readonly openBusy = signal(false)
	protected readonly openSessionConflict = signal<ProjectOpenSessionConflict | null>(null)
	private readonly actions = createProjectOpenActions({
		core: this.core,
		desktop: this.desktop,
		router: this.router,
		state: {
			runtimeInfo: this.runtimeInfo,
			recentProjects: this.recentProjects,
			selectedPath: this.selectedPath,
			resolvedProjectPath: this.resolvedProjectPath,
			previewLifecycle: this.previewLifecycle,
			statusMessage: this.statusMessage,
			openBusy: this.openBusy,
			openSessionConflict: this.openSessionConflict
		},
		selectDesktopProjectPath
	})

	async ngOnInit() {
		this.runtimeInfo.set(await loadProjectOpenRuntimeInfo(this.desktop, loadDesktopHostRuntimeInfo))
		this.recentProjects.set(await loadProjectOpenRecentProjects(this.core, this.runtimeInfo(), config))
		this.loading.set(false)
	}

	protected readonly chooseProjectPath = () => this.actions.chooseProjectPath()
	protected readonly useRecentProject = (project: RecentlyProjectEntry) => this.actions.useRecentProject(project)
	protected readonly previewSelectedPath = () => this.actions.previewSelectedPath()
	protected readonly openProject = () => this.actions.openProject()
	protected readonly cancelConflictOpen = () => this.actions.cancelConflictOpen()
	protected readonly focusConflictOwner = () => this.actions.focusConflictOwner()
	protected readonly forceOpenProject = () => this.actions.forceOpenProject()
}
