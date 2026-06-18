import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmDialogFooter],hlm-dialog-footer',
	host: { 'data-slot': 'dialog-footer' }
})
export class HlmDialogFooter {
	constructor() {
		classes(() => 'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end')
	}
}
