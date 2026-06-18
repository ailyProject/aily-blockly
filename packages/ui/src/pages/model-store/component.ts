import { Component, computed, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import { modelCatalog } from '@/workspace'

@Component({
	selector: 'model-store-page',
	imports: [HlmBadgeImports, HlmCardImports, HlmInputImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ModelStorePageComponent {
	protected readonly catalog = modelCatalog
	protected readonly query = signal('')
	protected readonly activeTask = signal('all')
	protected readonly taskOptions = ['all', ...new Set(modelCatalog.map(item => item.task))]
	protected readonly filteredCatalog = computed(() => {
		const query = this.query().trim().toLowerCase()
		const task = this.activeTask()

		return this.catalog.filter(item => {
			const matchesTask = task === 'all' || item.task === task
			const matchesQuery =
				!query || `${item.name} ${item.author} ${item.board} ${item.summary}`.toLowerCase().includes(query)
			return matchesTask && matchesQuery
		})
	})
	protected readonly taskCounts = computed(() =>
		this.taskOptions.map(task => ({
			task,
			count: task === 'all' ? this.catalog.length : this.catalog.filter(item => item.task === task).length
		}))
	)

	protected updateQuery(event: Event) {
		this.query.set((event.target as HTMLInputElement).value)
	}

	protected setActiveTask(task: string) {
		this.activeTask.set(task)
	}
}
