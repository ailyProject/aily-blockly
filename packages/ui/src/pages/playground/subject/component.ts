import { Component, computed, inject } from '@angular/core'
import { ActivatedRoute, RouterLink } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { playgroundSubjects } from '../data'

@Component({
	selector: 'playground-subject-page',
	imports: [HlmBadgeImports, HlmCardImports, RouterLink],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class PlaygroundSubjectPageComponent {
	private readonly route = inject(ActivatedRoute)

	protected readonly subject = computed(() => {
		const id = this.route.snapshot.paramMap.get('name')
		return playgroundSubjects.find(item => item.id === id) ?? null
	})
}
