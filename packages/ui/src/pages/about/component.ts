import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { AppShellComponent } from '@/layout/app-shell.component'
import { getCore } from '@/utils/core'

import type { AilyCoreServiceHealth } from 'shared'

@Component({
	selector: 'about-page',
	imports: [AppShellComponent, HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class AboutPageComponent implements OnInit {
	private readonly core = getCore()

	protected readonly health = signal<AilyCoreServiceHealth | null>(null)

	async ngOnInit() {
		this.health.set(await this.core.health.query())
	}
}
