import { Component, OnInit, signal } from '@angular/core'
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { injectDesktop } from '@/desktop-service'

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
	private readonly desktop = injectDesktop()

	protected readonly tabs = deployTabs
	protected readonly health = signal<AilyCoreServiceHealth | null>(null)
	protected readonly deployTargetCount = signal(0)
	protected readonly serialPortCount = signal(0)
	protected readonly platform = signal('web')
	protected readonly probeCount = signal(0)
	protected readonly esptoolAvailable = signal(false)
	protected readonly firmwareVersion = signal<string | null>(null)

	async ngOnInit() {
		const state = await loadModelDeployState(this.core, this.desktop)
		this.health.set(state.health)
		this.deployTargetCount.set(state.deployTargetCount)
		this.serialPortCount.set(state.serialPortCount)
		this.platform.set(state.platform)
		this.probeCount.set(state.probeCount)
		this.esptoolAvailable.set(state.esptoolAvailable)
		this.firmwareVersion.set(state.firmwareVersion)
	}
}
