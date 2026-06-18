import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmDialogHeader],hlm-dialog-header',
	host: { 'data-slot': 'dialog-header' }
})
export class HlmDialogHeader {
	constructor() {
		classes(() => 'gap-2 flex flex-col')
	}
}
