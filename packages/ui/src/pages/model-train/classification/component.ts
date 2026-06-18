import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { loadModelCatalog } from '@/runtime/model-catalog'

import { classificationChecklist } from '../data'

import type { ModelCatalogItem } from 'shared'

@Component({
	selector: 'classification-train-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ClassificationTrainPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly checklist = classificationChecklist
	protected readonly models = signal<Array<ModelCatalogItem>>([])

	async ngOnInit() {
		const result = await loadModelCatalog(this.core)
		this.models.set(result.items.filter(item => item.task === 'classification'))
	}
}
