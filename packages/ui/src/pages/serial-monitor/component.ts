import { Component, computed, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { AppShellComponent } from '@/layout/app-shell.component'
import { config, toolbarApps } from '@/workspace'

import type { AilyAppConfig } from 'shared'
import type { SerialMonitorSnapshot } from './types'

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
					this.core.config.get.query({ config, fallbackLanguage: config.lang }),
					this.core.config.previewUpdate.query({
						config,
						serialMonitor: { port: 'COM9', baudRate: '921600' }
					}),
					this.core.store.createDefaultLayout.query({
						defaultToolbarAppIds: config.toolbarAppIds ?? [],
						apps: toolbarApps
					}),
					this.core.store.mergeVisibleOrder.query({
						currentZoneIds: config.toolbarAppIds ?? [],
						visibleIds: ['flash-fs', 'aily-chat'],
						visibleCatalogIds: toolbarApps.map(app => app.id)
					}),
					this.core.store.toggleApp.query({
						layout: { version: 2, zones: { header: config.toolbarAppIds ?? [] } },
						zone: 'header',
						appId: 'dev-tool',
						apps: toolbarApps
					}),
					this.core.store.reset.query({
						defaultToolbarAppIds: config.toolbarAppIds ?? [],
						apps: toolbarApps
					}),
					this.core.config.buildSerialConnectOptions.query({ config, port: 'COM9' })
				]
			)
			const previewConfig = previewConfigRaw as AilyAppConfig

			const serialPorts = await this.core.hardware.listSerialPorts.query()

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
				resetToolbarAppCount: reset.zones.header.length,
				serialPortCount: serialPorts.ports.length,
				serialPlatform: serialPorts.platform,
				desktopSerialAvailable: serialPorts.available
			})
		} catch (error) {
			this.error.set((error as Error).message)
		} finally {
			this.loading.set(false)
		}
	}
}
