import { Component, computed, inject, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import { injectCore } from '@/core-service'

import {
	projectNewBoardOptions,
	projectNewInitialName,
	projectNewRecentConfig,
	projectNewSeparator,
	projectNewUserDocuments
} from './data'

import type { ProjectNewRecentItem } from './types'

@Component({
	selector: 'project-new-page',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports, HlmInputImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ProjectNewPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly loading = signal(true)
	protected readonly error = signal<string | null>(null)
	protected readonly projectName = signal(projectNewInitialName)
	protected readonly selectedBoardName = signal(projectNewBoardOptions[0]?.displayName ?? 'XIAO ESP32S3')
	protected readonly rootPath = signal('')
	protected readonly resolvedProjectPath = signal('')
	protected readonly recentProjects = signal<Array<ProjectNewRecentItem>>([])
	protected readonly pathConflict = signal<boolean | null>(null)
	protected readonly boardOptions = projectNewBoardOptions
	protected readonly canPreview = computed(() => this.rootPath().length > 0 && this.projectName().trim().length > 0)

	async ngOnInit() {
		await this.refresh()
	}

	protected async refresh() {
		this.loading.set(true)
		this.error.set(null)

		try {
			const [rootPath, recentProjects] = await Promise.all([
				this.core.project.getDefaultProjectRootPath.query({
					userDocuments: projectNewUserDocuments,
					separator: projectNewSeparator
				}),
				this.core.project.getRecentProjects.query({ config: projectNewRecentConfig })
			])

			this.rootPath.set(rootPath)
			this.recentProjects.set(recentProjects)
			await this.preview()
		} catch (error) {
			this.error.set((error as Error).message)
		} finally {
			this.loading.set(false)
		}
	}

	protected updateProjectName(event: Event) {
		this.projectName.set((event.target as HTMLInputElement).value)
		void this.preview()
	}

	protected async preview() {
		if (!this.canPreview()) return

		const path = await this.core.project.resolveProjectPath.query({
			basePath: this.rootPath(),
			name: this.projectName().trim(),
			separator: projectNewSeparator
		})

		this.resolvedProjectPath.set(path)
		this.pathConflict.set(this.recentProjects().some(item => item.path === path))
	}

	protected chooseBoard(boardName: string) {
		this.selectedBoardName.set(boardName)
	}

	protected useRecentProject(project: ProjectNewRecentItem) {
		this.projectName.set(project.nickname || project.name)
		this.resolvedProjectPath.set(project.path)
		this.pathConflict.set(true)
	}
}
