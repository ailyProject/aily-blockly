import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { getCore } from '@/utils/core'
import { config, toolbarApps } from '@/workspace'

import { loadAppStorePageState } from './runtime'

import type { AppStorePageState } from './types'

@Component({
	selector: 'app-store-page',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class AppStorePageComponent implements OnInit {
	private readonly core = getCore()

	protected readonly state = signal<AppStorePageState | null>(null)

	async ngOnInit() {
		this.state.set(await loadAppStorePageState(this.core))
	}

	protected async toggleApp(appId: string) {
		const current = this.state()
		if (!current) return

		const result = await this.core.store.toggleApp.query({
			layout: { version: 2, zones: { header: config.toolbarAppIds ?? [] } },
			zone: 'header',
			appId,
			apps: toolbarApps
		})

		const pinnedIds = new Set(result.zones.header)
		this.state.update(state =>
			state
				? {
						...state,
						toolbarCount: result.zones.header.length,
						visibleToolbarCount: result.zones.header.length,
						pinnedIds: [...result.zones.header],
						apps: state.apps.map(app => ({
							...app,
							pinned: pinnedIds.has(app.id),
							visible: pinnedIds.has(app.id) ? true : app.visible
						}))
					}
				: state
		)
	}

	protected async resetLayout() {
		const result = await this.core.store.reset.query({
			defaultToolbarAppIds: config.toolbarAppIds ?? [],
			apps: toolbarApps
		})

		const pinnedIds = new Set(result.zones.header)
		this.state.update(state =>
			state
				? {
						...state,
						toolbarCount: result.zones.header.length,
						visibleToolbarCount: result.zones.header.length,
						pinnedIds: [...result.zones.header],
						apps: state.apps.map(app => ({
							...app,
							pinned: pinnedIds.has(app.id)
						}))
					}
				: state
		)
	}

	protected async movePinnedApp(appId: string, direction: -1 | 1) {
		const current = this.state()
		if (!current) return

		const nextIds = [...current.pinnedIds]
		const currentIndex = nextIds.indexOf(appId)
		const nextIndex = currentIndex + direction
		if (currentIndex === -1 || nextIndex < 0 || nextIndex >= nextIds.length) return
		;[nextIds[currentIndex], nextIds[nextIndex]] = [nextIds[nextIndex], nextIds[currentIndex]]

		const result = await this.core.store.setLayout.query({
			layout: { version: 2, zones: { header: current.pinnedIds } },
			zone: 'header',
			appIds: nextIds,
			apps: toolbarApps
		})

		this.state.update(state =>
			state
				? {
						...state,
						pinnedIds: [...result.zones.header]
					}
				: state
		)
	}
}
