import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'

import { loadSimulatorState } from './runtime'

import type { SimulatorState } from './types'

@Component({
	selector: 'simulator-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class SimulatorPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly state = signal<SimulatorState | null>(null)

	async ngOnInit() {
		this.state.set(await loadSimulatorState(this.core))
	}
}
