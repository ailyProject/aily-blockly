import { Component, OnInit, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { loadModelCatalog } from '@/runtime/model-catalog'

@Component({
	selector: 'vision-train-page',
	imports: [HlmBadgeImports, HlmCardImports, RouterLink],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class VisionTrainPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly classificationCount = signal(0)
	protected readonly detectionCount = signal(0)

	async ngOnInit() {
		const result = await loadModelCatalog(this.core)
		this.classificationCount.set(result.items.filter(item => item.task === 'classification').length)
		this.detectionCount.set(result.items.filter(item => item.task === 'detection').length)
	}
}
