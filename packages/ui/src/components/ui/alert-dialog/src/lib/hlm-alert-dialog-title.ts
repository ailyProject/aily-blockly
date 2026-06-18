import { Directive } from '@angular/core'
import { BrnAlertDialogTitle } from '@spartan-ng/brain/alert-dialog'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmAlertDialogTitle]',
	hostDirectives: [BrnAlertDialogTitle],
	host: { 'data-slot': 'alert-dialog-title' }
})
export class HlmAlertDialogTitle {
	constructor() {
		classes(
			() =>
				'text-lg font-medium sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2'
		)
	}
}
