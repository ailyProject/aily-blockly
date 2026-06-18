import { Component } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { detectionChecklist } from '../data'

@Component({
	selector: 'detection-train-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class DetectionTrainPageComponent {
	protected readonly checklist = detectionChecklist
}
