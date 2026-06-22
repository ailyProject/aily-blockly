import { Component, OnInit, signal } from '@angular/core'
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { primaryRouteLinks } from '@/pages/main/data'
import { getCore } from '@/utils/core'

@Component({
	selector: 'playground-page',
	imports: [HlmBadgeImports, HlmCardImports, RouterLink, RouterLinkActive, RouterOutlet],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class PlaygroundPageComponent implements OnInit {
	private readonly core = getCore()

	protected readonly categories = signal<Array<{ name: string; count: number }>>([])
	protected readonly links = primaryRouteLinks.filter(item => item.href !== '/main/playground')

	async ngOnInit() {
		const boards = await this.core.hardware.getBoardCategories.query({
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
				},
				{
					name: 'uno-r4',
					displayName: 'Arduino UNO R4',
					brand: 'Arduino',
					type: 'board',
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
			],
			dimension: 'brand'
		})

		this.categories.set(boards.categories)
	}
}
