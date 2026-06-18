import { Component } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { modelCatalog } from '@/workspace'

import { detectionChecklist } from '../data'

@Component({
	selector: 'detection-train-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class DetectionTrainPageComponent {
	protected readonly checklist = detectionChecklist
	protected readonly models = modelCatalog.filter(item => item.task === 'detection')
}
