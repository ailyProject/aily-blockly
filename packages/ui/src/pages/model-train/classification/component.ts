import { Component } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { modelCatalog } from '@/workspace'

import { classificationChecklist } from '../data'

@Component({
	selector: 'classification-train-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ClassificationTrainPageComponent {
	protected readonly checklist = classificationChecklist
	protected readonly models = modelCatalog.filter(item => item.task === 'classification')
}
