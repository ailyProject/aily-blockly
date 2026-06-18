import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmFieldContent],hlm-field-content',
	host: { 'data-slot': 'field-content' }
})
export class HlmFieldContent {
	constructor() {
		classes(() => 'gap-1 group/field-content flex flex-1 flex-col leading-snug')
	}
}
