import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmFieldGroup],hlm-field-group',
	host: { 'data-slot': 'field-group' }
})
export class HlmFieldGroup {
	constructor() {
		classes(
			() =>
				'gap-7 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4 group/field-group @container/field-group flex w-full flex-col'
		)
	}
}
