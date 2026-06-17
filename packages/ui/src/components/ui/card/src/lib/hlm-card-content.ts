import { Directive } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmCardContent]',
	host: { 'data-slot': 'card-content' }
})
export class HlmCardContent {
	constructor() {
		classes(() => 'px-(--card-spacing)')
	}
}
