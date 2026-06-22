import { Component, input } from '@angular/core'

import { HlmProgressImports } from '@/components/ui/progress/src'

import type { LibManagerActionOutput, LibManagerLiveActionStatus } from '../types'

@Component({
	selector: 'lib-manager-activity-section',
	imports: [HlmProgressImports],
	templateUrl: './activity-section.component.html'
})
export class LibManagerActivitySectionComponent {
	readonly lastActionOutput = input<LibManagerActionOutput | null>(null)
	readonly liveActionStatus = input<LibManagerLiveActionStatus | null>(null)
	readonly liveActionProgressPercent = input<number | null>(null)
	readonly liveActionLatestLine = input<string | null>(null)
}
