import { Directive } from '@angular/core'
import { BrnComboboxEmpty } from '@spartan-ng/brain/combobox'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmComboboxEmpty],hlm-combobox-empty',
	hostDirectives: [BrnComboboxEmpty],
	host: { 'data-slot': 'combobox-empty' }
})
export class HlmComboboxEmpty {
	constructor() {
		classes(
			() =>
				'text-muted-foreground hidden w-full items-center justify-center gap-2 py-2 text-center text-sm group-data-empty/combobox-content:flex'
		)
	}
}
