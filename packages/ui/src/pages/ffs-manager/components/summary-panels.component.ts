import { Component, input } from '@angular/core'
import { HlmCardImports } from 'spartan/card'

import type { FfsManagerState } from '../types'

/**
 * FFS Manager 顶部摘要面板。
 */
@Component({
	selector: 'ffs-manager-summary-panels',
	imports: [HlmCardImports],
	templateUrl: './summary-panels.component.html',
	styleUrl: './summary-panels.component.css'
})
export class FfsManagerSummaryPanelsComponent {
	readonly state = input<FfsManagerState | null>(null)
}
