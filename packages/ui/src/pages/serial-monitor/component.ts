import { Component, computed, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { AppShellComponent } from '@/layout/app-shell.component'
import { loadHomePageCoreState } from '@/pages/home/runtime'

import type { HomePageCoreState } from '@/pages/home/types'

@Component({
	selector: 'serial-monitor-page',
	imports: [AppShellComponent, HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class SerialMonitorPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly state = signal<HomePageCoreState | null>(null)
	protected readonly loading = signal(true)
	protected readonly error = signal<string | null>(null)
	protected readonly serialModeLabel = computed(() => {
		const current = this.state()
		if (!current) return 'loading'
		return current.appConfigSummary.serialInputHexMode ? 'hex input' : 'text input'
	})

	async ngOnInit() {
		await this.refresh()
	}

	protected async refresh() {
		this.loading.set(true)
		this.error.set(null)

		try {
			this.state.set(await loadHomePageCoreState(this.core))
		} catch (error) {
			this.error.set((error as Error).message)
		} finally {
			this.loading.set(false)
		}
	}
}
