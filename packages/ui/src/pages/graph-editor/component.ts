import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'

@Component({
	selector: 'graph-editor-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class GraphEditorPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly connectivityCategories = signal<Array<{ name: string; count: number }>>([])
	protected readonly interfaceCategories = signal<Array<{ name: string; count: number }>>([])

	async ngOnInit() {
		const boards = [
			{
				name: 'xiao-esp32s3',
				displayName: 'XIAO ESP32S3',
				brand: 'Seeed',
				type: 'board' as const,
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
			},
			{
				name: 'uno-r4',
				displayName: 'Arduino UNO R4',
				brand: 'Arduino',
				type: 'board' as const,
				architecture: 'renesas',
				cores: 1,
				frequency: 48,
				frequencyUnit: 'MHz',
				flash: 256,
				sram: 32,
				psram: 0,
				connectivity: ['usb'],
				interfaces: ['i2c', 'spi', 'uart'],
				core: 'renesas',
				voltage: 5,
				tags: ['classic', 'education']
			}
		]

		const [connectivity, interfaces] = await Promise.all([
			this.core.hardware.getBoardCategories.query({ boards, dimension: 'connectivity' }),
			this.core.hardware.getBoardCategories.query({ boards, dimension: 'interfaces' })
		])

		this.connectivityCategories.set(connectivity.categories)
		this.interfaceCategories.set(interfaces.categories)
	}
}
