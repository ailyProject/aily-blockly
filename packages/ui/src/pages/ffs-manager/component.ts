import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { seedAppConfig } from '@/pages/home/data'

@Component({
	selector: 'ffs-manager-page',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class FfsManagerPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly serialSummary = signal<{ baudRate: string; port?: string } | null>(null)
	protected readonly connectSummary = signal<{ path: string; baudRate: number } | null>(null)

	async ngOnInit() {
		const [config, connect] = await Promise.all([
			this.core.config.get.query({ config: seedAppConfig }),
			this.core.config.buildSerialConnectOptions.query({ config: seedAppConfig, port: 'COM9' })
		])

		this.serialSummary.set(config.serialMonitor)
		this.connectSummary.set(connect)
	}
}
