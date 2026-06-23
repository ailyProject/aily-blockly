import { Component, computed, inject, OnInit, signal } from '@angular/core'
import { ActivatedRoute, Router, RouterLink } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import { importCloudSpaceProject } from '@/pages/cloud-space/runtime/import'
import { projectNewSeparator, projectNewUserDocuments } from '@/pages/project-new/data'
import { openProjectInEditor } from '@/runtime/project-routing'
import { getCore } from '@/utils/core'
import { getDesktop, loadDesktopHostRuntimeInfo } from '@/utils/desktop'

import { playgroundSubjects } from '../data'

import type { CloudProjectSummary } from 'shared'

@Component({
	selector: 'playground-list-page',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports, HlmInputImports, RouterLink],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class PlaygroundListPageComponent implements OnInit {
	private readonly core = getCore()
	private readonly desktop = getDesktop()
	private readonly route = inject(ActivatedRoute)
	private readonly router = inject(Router)

	protected readonly query = signal('')
	protected readonly cloudExamples = signal<Array<CloudProjectSummary>>([])
	protected readonly cloudLoading = signal(true)
	protected readonly importBusyId = signal<string | null>(null)
	protected readonly statusMessage = signal<string | null>(null)
	private runtimeInfo: Awaited<ReturnType<typeof loadDesktopHostRuntimeInfo>> | null = null
	private rootPath = ''
	protected readonly subjects = computed(() => {
		const searchText = this.query().trim().toLowerCase()
		const boardFilter = String(this.route.snapshot.queryParamMap.get('board') ?? '')
			.trim()
			.toLowerCase()

		return playgroundSubjects.filter(subject => {
			const matchesKeyword =
				!searchText ||
				subject.title.toLowerCase().includes(searchText) ||
				subject.summary.toLowerCase().includes(searchText) ||
				subject.examples.some(example =>
					`${example.title} ${example.summary} ${example.board}`.toLowerCase().includes(searchText)
				)

			const matchesBoard =
				!boardFilter || subject.examples.some(example => example.board.toLowerCase().includes(boardFilter))

			return matchesKeyword && matchesBoard
		})
	})

	protected updateQuery(event: Event) {
		this.query.set((event.target as HTMLInputElement).value)
	}

	async ngOnInit() {
		if (this.desktop) {
			this.runtimeInfo = await loadDesktopHostRuntimeInfo(this.desktop).catch(() => null)
		}
		this.rootPath = await this.core.project.getDefaultProjectRootPath.query({
			userDocuments: this.runtimeInfo?.documentsPath || projectNewUserDocuments,
			separator: this.runtimeInfo?.pathSeparator || projectNewSeparator
		})
		await this.refreshCloudExamples()
	}

	protected async refreshCloudExamples() {
		this.cloudLoading.set(true)
		this.statusMessage.set(null)
		try {
			const result = await this.core.cloud.listPublicProjects.query({
				page: 1,
				pageSize: 12
			})
			this.cloudExamples.set(result.items)
		} catch (error) {
			this.statusMessage.set(error instanceof Error ? error.message : String(error))
			this.cloudExamples.set([])
		} finally {
			this.cloudLoading.set(false)
		}
	}

	protected async importExample(project: CloudProjectSummary) {
		if (!this.rootPath.trim()) {
			this.statusMessage.set('Default project root path is unavailable.')
			return
		}

		this.importBusyId.set(project.id)
		this.statusMessage.set(null)
		try {
			const result = await importCloudSpaceProject({
				core: this.core,
				project,
				rootPath: this.rootPath,
				targetName: project.nickname || project.name,
				runtimeInfo: this.runtimeInfo?.available ? this.runtimeInfo : null
			})
			this.statusMessage.set(result.message)

			if (result.success && result.projectPath) {
				await openProjectInEditor(this.core, this.router, result.projectPath)
			}
		} catch (error) {
			this.statusMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			this.importBusyId.set(null)
		}
	}
}
