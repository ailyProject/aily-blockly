import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmCardHeader],hlm-card-header',
	host: { 'data-slot': 'card-header' }
})
export class HlmCardHeader {
	constructor() {
		classes(
			() =>
				'gap-1 rounded-t-xl px-(--card-spacing) [.border-b]:pb-(--card-spacing) group/card-header @container/card-header grid auto-rows-min items-start has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto]'
		)
	}
}
