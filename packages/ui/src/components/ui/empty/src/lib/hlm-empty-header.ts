import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmEmptyHeader],hlm-empty-header',
	host: { 'data-slot': 'empty-header' }
})
export class HlmEmptyHeader {
	constructor() {
		classes(() => 'gap-2 flex max-w-sm flex-col items-center')
	}
}
