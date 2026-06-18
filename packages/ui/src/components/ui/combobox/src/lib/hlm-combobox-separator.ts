import { Directive } from '@angular/core'
import { BrnComboboxSeparator } from '@spartan-ng/brain/combobox'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmComboboxSeparator]',
	hostDirectives: [{ directive: BrnComboboxSeparator, inputs: ['orientation'] }],
	host: { 'data-slot': 'combobox-separator' }
})
export class HlmComboboxSeparator {
	constructor() {
		classes(() => 'bg-border -mx-1 my-1 h-px')
	}
}
