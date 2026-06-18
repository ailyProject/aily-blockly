import { Directive } from '@angular/core'
import { BrnComboboxLabel } from '@spartan-ng/brain/combobox'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmComboboxLabel]',
	hostDirectives: [{ directive: BrnComboboxLabel, inputs: ['id'] }],
	host: { 'data-slot': 'combobox-label' }
})
export class HlmComboboxLabel {
	constructor() {
		classes(() => 'text-muted-foreground px-2 py-1.5 text-xs')
	}
}
