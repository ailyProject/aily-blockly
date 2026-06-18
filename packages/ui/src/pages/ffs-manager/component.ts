import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'

import { loadFfsManagerState } from './runtime'

import type { FfsManagerState } from './types'

@Component({
	selector: 'ffs-manager-page',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class FfsManagerPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly state = signal<FfsManagerState | null>(null)

	async ngOnInit() {
		this.state.set(await loadFfsManagerState(this.core))
	}
}
