import { Directive } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmCardAction]',
	host: { 'data-slot': 'card-action' }
})
export class HlmCardAction {
	constructor() {
		classes(() => 'col-start-2 row-span-2 row-start-1 self-start justify-self-end')
	}
}
