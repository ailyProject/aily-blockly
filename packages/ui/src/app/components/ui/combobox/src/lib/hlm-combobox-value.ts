import { Directive } from '@angular/core'
import { BrnComboboxValue } from '@spartan-ng/brain/combobox'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmComboboxValue],hlm-combobox-value',
	hostDirectives: [{ directive: BrnComboboxValue, inputs: ['placeholder'] }],
	host: { 'data-slot': 'combobox-value' }
})
export class HlmComboboxValue {
	constructor() {
		classes(() => 'data-hidden:hidden')
	}
}
