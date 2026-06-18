import { Directive } from '@angular/core'
import { BrnDialogDescription } from '@spartan-ng/brain/dialog'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmDialogDescription]',
	hostDirectives: [BrnDialogDescription],
	host: { 'data-slot': 'dialog-description' }
})
export class HlmDialogDescription {
	constructor() {
		classes(() => 'text-muted-foreground *:[a]:hover:text-foreground text-sm *:[a]:underline *:[a]:underline-offset-3')
	}
}
