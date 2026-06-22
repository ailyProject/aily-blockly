import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { loadModelCatalog } from '@/runtime/model-catalog'
import { getCore } from '@/utils/core'

import { detectionChecklist } from '../data'

import type { ModelCatalogItem } from 'shared'

@Component({
	selector: 'detection-train-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class DetectionTrainPageComponent implements OnInit {
	private readonly core = getCore()

	protected readonly checklist = detectionChecklist
	protected readonly models = signal<Array<ModelCatalogItem>>([])

	async ngOnInit() {
		const result = await loadModelCatalog(this.core)
		this.models.set(result.items.filter(item => item.task === 'detection'))
	}
}
