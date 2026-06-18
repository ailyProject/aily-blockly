import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'

@Component({
	selector: 'simulator-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class SimulatorPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly compatCount = signal(0)

	async ngOnInit() {
		const result = await this.core.hardware.searchCompat.query({
			boards: [
				{
					name: 'xiao-esp32s3',
					displayName: 'XIAO ESP32S3',
					brand: 'Seeed',
					type: 'board',
					architecture: 'xtensa',
					cores: 2,
					frequency: 240,
					frequencyUnit: 'MHz',
					flash: 8192,
					sram: 512,
					psram: 8192,
					connectivity: ['wifi', 'ble'],
					interfaces: ['i2c', 'spi', 'uart'],
					core: 'esp32',
					voltage: 3.3,
					tags: ['compact', 'wifi']
				}
			],
			libraries: [],
			query: { query: 'esp32', type: 'boards' }
		})

		this.compatCount.set(result.length)
	}
}
