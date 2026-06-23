import { Component, OnInit, signal } from '@angular/core'
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { getCore } from '@/utils/core'
import { getDesktop, loadDesktopHostRuntimeInfo } from '@/utils/desktop'

import { deployTabs } from './data'
import { loadModelDeployState } from './runtime'

import type { DesktopHostRuntimeInfo } from '@desktop'
import type { AilyCoreServiceHealth } from 'shared'

@Component({
	selector: 'model-deploy-page',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports, RouterLink, RouterLinkActive, RouterOutlet],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ModelDeployPageComponent implements OnInit {
	private readonly core = getCore()
	private readonly desktop = getDesktop()

	protected readonly tabs = deployTabs
	protected readonly health = signal<AilyCoreServiceHealth | null>(null)
	protected readonly deployTargetCount = signal(0)
	protected readonly serialPortCount = signal(0)
	protected readonly platform = signal('web')
	protected readonly probeCount = signal(0)
	protected readonly esptoolAvailable = signal(false)
	protected readonly firmwareVersion = signal<string | null>(null)
	protected readonly installBusy = signal(false)
	protected readonly installMessage = signal<string | null>(null)
	private runtimeInfo: DesktopHostRuntimeInfo | null = null

	async ngOnInit() {
		if (this.desktop) {
			this.runtimeInfo = await loadDesktopHostRuntimeInfo(this.desktop).catch(() => null)
		}
		await this.refresh()
	}

	protected async refresh() {
		const state = await loadModelDeployState(this.core, this.desktop)
		this.health.set(state.health)
		this.deployTargetCount.set(state.deployTargetCount)
		this.serialPortCount.set(state.serialPortCount)
		this.platform.set(state.platform)
		this.probeCount.set(state.probeCount)
		this.esptoolAvailable.set(state.esptoolAvailable)
		this.firmwareVersion.set(state.firmwareVersion)
	}

	protected async installEsptool() {
		if (!this.runtimeInfo?.available) {
			this.installMessage.set('Desktop runtime info is unavailable, so esptool cannot be installed here.')
			return
		}

		this.installBusy.set(true)
		this.installMessage.set(null)
		try {
			const result = await this.core.hardware.installEsptool.mutate({
				appDataPath: this.runtimeInfo.appDataPath,
				platform: this.runtimeInfo.platform
			})
			this.installMessage.set(
				result.message || result.error || (result.success ? 'esptool installed.' : 'esptool install failed.')
			)
			await this.refresh()
		} catch (error) {
			this.installMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			this.installBusy.set(false)
		}
	}
}
