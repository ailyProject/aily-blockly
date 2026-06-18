import { Component, OnInit, signal } from '@angular/core'
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'

import { modelTrainTabs } from './data'
import { loadModelTrainState } from './runtime'

import type { RecentModelProject } from 'shared'

@Component({
	selector: 'model-train-page',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports, RouterLink, RouterLinkActive, RouterOutlet],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ModelTrainPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly tabs = modelTrainTabs
	protected readonly recentModels = signal<Array<RecentModelProject>>([])
	protected readonly classificationCount = signal(0)
	protected readonly detectionCount = signal(0)

	async ngOnInit() {
		const state = await loadModelTrainState(this.core)
		this.recentModels.set(state.recentModels)
		this.classificationCount.set(state.classificationCount)
		this.detectionCount.set(state.detectionCount)
	}
}
