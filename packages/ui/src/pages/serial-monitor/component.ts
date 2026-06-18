import { Component, computed, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { AppShellComponent } from '@/layout/app-shell.component'
import { seedAppConfig, seedToolbarApps } from '@/pages/home/data'

import type { AilyAppConfig } from 'shared'

export interface SerialMonitorSnapshot {
	baudRate: string
	connectBaudRate: number
	autoScroll: boolean
	hexInput: boolean
	previewPort: string
	quickSendCount: number
	toolbarAppCount: number
	visibleToolbarAppCount: number
	defaultToolbarAppCount: number
	mergedToolbarOrderCount: number
	toggledToolbarAppCount: number
	resetToolbarAppCount: number
}

@Component({
	selector: 'serial-monitor-page',
	imports: [AppShellComponent, HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class SerialMonitorPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly state = signal<SerialMonitorSnapshot | null>(null)
	protected readonly loading = signal(true)
	protected readonly error = signal<string | null>(null)
	protected readonly serialModeLabel = computed(() => {
		const current = this.state()
		if (!current) return 'loading'
		return current.hexInput ? 'hex input' : 'text input'
	})

	async ngOnInit() {
		await this.refresh()
	}

	protected async refresh() {
		this.loading.set(true)
		this.error.set(null)

		try {
			const [configSummary, previewConfigRaw, defaultLayout, merged, toggled, reset, serialConnect] = await Promise.all(
				[
					this.core.config.get.query({ config: seedAppConfig, fallbackLanguage: seedAppConfig.lang }),
					this.core.config.previewUpdate.query({
						config: seedAppConfig,
						serialMonitor: { port: 'COM9', baudRate: '921600' }
					}),
					this.core.store.createDefaultLayout.query({
						defaultToolbarAppIds: seedAppConfig.toolbarAppIds ?? [],
						apps: seedToolbarApps
					}),
					this.core.store.mergeVisibleOrder.query({
						currentZoneIds: seedAppConfig.toolbarAppIds ?? [],
						visibleIds: ['flash-fs', 'aily-chat'],
						visibleCatalogIds: seedToolbarApps.map(app => app.id)
					}),
					this.core.store.toggleApp.query({
						layout: { version: 2, zones: { header: seedAppConfig.toolbarAppIds ?? [] } },
						zone: 'header',
						appId: 'dev-tool',
						apps: seedToolbarApps
					}),
					this.core.store.reset.query({
						defaultToolbarAppIds: seedAppConfig.toolbarAppIds ?? [],
						apps: seedToolbarApps
					}),
					this.core.config.buildSerialConnectOptions.query({ config: seedAppConfig, port: 'COM9' })
				]
			)
			const previewConfig = previewConfigRaw as AilyAppConfig

			this.state.set({
				baudRate: configSummary.serialMonitor.baudRate,
				connectBaudRate: serialConnect.baudRate,
				autoScroll: configSummary.serialViewMode.autoScroll,
				hexInput: configSummary.serialInputMode.hexMode,
				previewPort: previewConfig.serialMonitor?.port ?? 'unset',
				quickSendCount: configSummary.quickSendList.length,
				toolbarAppCount: configSummary.toolbarAppIds.length,
				visibleToolbarAppCount: merged.length,
				defaultToolbarAppCount: defaultLayout.zones.header.length,
				mergedToolbarOrderCount: merged.length,
				toggledToolbarAppCount: toggled.zones.header.length,
				resetToolbarAppCount: reset.zones.header.length
			})
		} catch (error) {
			this.error.set((error as Error).message)
		} finally {
			this.loading.set(false)
		}
	}
}
