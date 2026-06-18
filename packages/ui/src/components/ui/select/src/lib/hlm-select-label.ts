import { Directive } from '@angular/core'
import { BrnSelectLabel } from '@spartan-ng/brain/select'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmSelectLabel],hlm-select-label',
	hostDirectives: [{ directive: BrnSelectLabel, inputs: ['id'] }],
	host: { 'data-slot': 'select-label' }
})
export class HlmSelectLabel {
	constructor() {
		classes(() => 'text-muted-foreground px-2 py-1.5 text-xs flex')
	}
}
