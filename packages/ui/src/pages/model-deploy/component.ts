import { Component, OnInit, signal } from '@angular/core'
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'

import { deployTabs } from './data'
import { loadModelDeployState } from './runtime'

import type { AilyCoreServiceHealth } from 'shared'

@Component({
	selector: 'model-deploy-page',
	imports: [HlmBadgeImports, HlmCardImports, RouterLink, RouterLinkActive, RouterOutlet],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ModelDeployPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly tabs = deployTabs
	protected readonly health = signal<AilyCoreServiceHealth | null>(null)
	protected readonly deployTargetCount = signal(0)

	async ngOnInit() {
		const state = await loadModelDeployState(this.core)
		this.health.set(state.health)
		this.deployTargetCount.set(state.deployTargetCount)
	}
}
