import { Directive } from '@angular/core'
import { BrnComboboxGroup } from '@spartan-ng/brain/combobox'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmComboboxGroup]',
	hostDirectives: [BrnComboboxGroup],
	host: { 'data-slot': 'combobox-group' }
})
export class HlmComboboxGroup {
	constructor() {
		classes(() => 'data-hidden:hidden')
	}
}
