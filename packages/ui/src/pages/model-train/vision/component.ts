import { Component } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { modelCatalog } from '@/workspace'

@Component({
	selector: 'vision-train-page',
	imports: [HlmBadgeImports, HlmCardImports, RouterLink],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class VisionTrainPageComponent {
	protected readonly classificationCount = modelCatalog.filter(item => item.task === 'classification').length
	protected readonly detectionCount = modelCatalog.filter(item => item.task === 'detection').length
}
