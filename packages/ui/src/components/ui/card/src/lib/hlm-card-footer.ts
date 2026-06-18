import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmCardFooter],hlm-card-footer',
	host: { 'data-slot': 'card-footer' }
})
export class HlmCardFooter {
	constructor() {
		classes(() => 'rounded-b-xl px-(--card-spacing) [.border-t]:pt-(--card-spacing) flex items-center')
	}
}
