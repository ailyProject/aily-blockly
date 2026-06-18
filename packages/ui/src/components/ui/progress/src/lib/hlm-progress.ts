import { Directive } from '@angular/core'
import { BrnProgress } from '@spartan-ng/brain/progress'
import { classes } from 'spartan/utils'

@Directive({
	selector: 'hlm-progress,[hlmProgress]',
	hostDirectives: [{ directive: BrnProgress, inputs: ['value', 'max', 'getValueLabel'] }]
})
export class HlmProgress {
	constructor() {
		classes(() => 'bg-muted h-1.5 rounded-full relative inline-flex w-full overflow-hidden')
	}
}
