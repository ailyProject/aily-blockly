import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'

@Component({
	selector: 'model-store-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ModelStorePageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly categories = signal<Array<{ name: string; count: number }>>([])

	async ngOnInit() {
		const result = await this.core.hardware.getLibraryCategories.query({
			libraries: [
				{
					name: '@aily-project/lib-oled-ssd1306',
					displayName: 'SSD1306 OLED',
					category: 'display',
					supportedCores: ['esp32'],
					communication: ['i2c'],
					voltage: [3.3],
					hardwareType: ['sensor'],
					compatibleHardware: ['esp32'],
					tags: ['oled']
				}
			],
			dimension: 'category'
		})

		this.categories.set(result.categories)
	}
}
