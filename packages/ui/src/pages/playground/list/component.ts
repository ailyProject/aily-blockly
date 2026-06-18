import { Component, computed, inject, signal } from '@angular/core'
import { ActivatedRoute, RouterLink } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import { playgroundSubjects } from '../data'

@Component({
	selector: 'playground-list-page',
	imports: [HlmBadgeImports, HlmCardImports, HlmInputImports, RouterLink],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class PlaygroundListPageComponent {
	private readonly route = inject(ActivatedRoute)

	protected readonly query = signal('')
	protected readonly subjects = computed(() => {
		const keyword = this.query().trim().toLowerCase()
		const boardFilter = String(this.route.snapshot.queryParamMap.get('board') ?? '')
			.trim()
			.toLowerCase()

		return playgroundSubjects.filter(subject => {
			const matchesKeyword =
				!keyword ||
				subject.title.toLowerCase().includes(keyword) ||
				subject.summary.toLowerCase().includes(keyword) ||
				subject.examples.some(example =>
					`${example.title} ${example.summary} ${example.board}`.toLowerCase().includes(keyword)
				)

			const matchesBoard =
				!boardFilter || subject.examples.some(example => example.board.toLowerCase().includes(boardFilter))

			return matchesKeyword && matchesBoard
		})
	})

	protected updateQuery(event: Event) {
		this.query.set((event.target as HTMLInputElement).value)
	}
}
