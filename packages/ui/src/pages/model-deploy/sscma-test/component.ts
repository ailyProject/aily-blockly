import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { loadHardwareHostSnapshot } from '@/runtime/hardware-host'
import { getCore } from '@/utils/core'
import { getDesktop } from '@/utils/desktop'

@Component({
	selector: 'sscma-test-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class SscmaTestPageComponent implements OnInit {
	private readonly core = getCore()
	private readonly desktop = getDesktop()

	protected readonly checks = signal<Array<string>>([])

	async ngOnInit() {
		const snapshot = await loadHardwareHostSnapshot(this.core, this.desktop, 'sscma_xiao_ai_s3')
		const health = snapshot.health
		this.checks.set([
			`core transport: ${health.transport}`,
			`health status: ${health.status}`,
			`runtime base url: ${health.address.baseUrl}`,
			`serial ports: ${snapshot.serialPorts.ports.length}`,
			`probes: ${snapshot.probes.probes?.length ?? 0}`,
			`esptool: ${snapshot.esptool?.installed ? 'ready' : 'missing'}`,
			`firmware: ${snapshot.firmware?.fwv ? String(snapshot.firmware.fwv) : 'unknown'}`
		])
	}
}
