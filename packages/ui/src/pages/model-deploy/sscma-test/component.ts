import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'

@Component({
	selector: 'sscma-test-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class SscmaTestPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly checks = signal<Array<string>>([])

	async ngOnInit() {
		const health = await this.core.health.query()
		this.checks.set([
			`core transport: ${health.transport}`,
			`health status: ${health.status}`,
			`runtime base url: ${health.address.baseUrl}`
		])
	}
}
