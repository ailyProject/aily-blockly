import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: 'fieldset[hlmFieldSet]',
	host: { 'data-slot': 'field-set' }
})
export class HlmFieldSet {
	constructor() {
		classes(() => 'gap-6 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3 flex flex-col')
	}
}
