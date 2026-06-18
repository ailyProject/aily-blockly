import { Component, computed, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import { injectCore } from '@/core-service'
import { loadModelCatalog } from '@/runtime/model-catalog'

import type { ModelCatalogItem, ModelCatalogSource } from 'shared'

@Component({
	selector: 'model-store-page',
	imports: [HlmBadgeImports, HlmCardImports, HlmInputImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ModelStorePageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly catalog = signal<Array<ModelCatalogItem>>([])
	protected readonly query = signal('')
	protected readonly activeTask = signal('all')
	protected readonly source = signal<ModelCatalogSource | null>(null)
	protected readonly loading = signal(true)
	protected readonly error = signal<string | null>(null)
	protected readonly taskOptions = computed(() => ['all', ...new Set(this.catalog().map(item => item.task))])
	protected readonly filteredCatalog = computed(() => {
		const query = this.query().trim().toLowerCase()
		const task = this.activeTask()

		return this.catalog().filter(item => {
			const matchesTask = task === 'all' || item.task === task
			const matchesQuery =
				!query ||
				`${item.name} ${item.authorName} ${item.supportedBoards.join(' ')} ${item.description}`
					.toLowerCase()
					.includes(query)
			return matchesTask && matchesQuery
		})
	})
	protected readonly taskCounts = computed(() =>
		this.taskOptions().map(task => ({
			task,
			count: task === 'all' ? this.catalog().length : this.catalog().filter(item => item.task === task).length
		}))
	)

	async ngOnInit() {
		try {
			const result = await loadModelCatalog(this.core)
			this.catalog.set(result.items)
			this.source.set(result.source)
		} catch (error) {
			this.error.set((error as Error).message)
		} finally {
			this.loading.set(false)
		}
	}

	protected updateQuery(event: Event) {
		this.query.set((event.target as HTMLInputElement).value)
	}

	protected setActiveTask(task: string) {
		this.activeTask.set(task)
	}
}
