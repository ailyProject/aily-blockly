import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmAlertAction]',
	host: {
		'data-slot': 'alert-action'
	}
})
export class HlmAlertAction {
	constructor() {
		classes(() => 'absolute end-3 top-2.5')
	}
}
