import { Component } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { classificationChecklist } from '../data'

@Component({
	selector: 'classification-train-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ClassificationTrainPageComponent {
	protected readonly checklist = classificationChecklist
}
