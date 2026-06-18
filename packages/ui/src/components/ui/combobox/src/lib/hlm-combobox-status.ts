import { Directive } from '@angular/core'
import { BrnComboboxStatus } from '@spartan-ng/brain/combobox'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmComboboxStatus],hlm-combobox-status',
	hostDirectives: [BrnComboboxStatus],
	host: { 'data-slot': 'combobox-status' }
})
export class HlmComboboxStatus {
	constructor() {
		classes(() => 'text-muted-foreground gap-2 py-2 text-sm flex w-full items-center justify-center text-center')
	}
}
