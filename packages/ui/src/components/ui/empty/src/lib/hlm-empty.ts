import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmEmpty],hlm-empty',
	host: { 'data-slot': 'empty' }
})
export class HlmEmpty {
	constructor() {
		classes(
			() =>
				'gap-4 rounded-lg border-dashed p-12 flex w-full min-w-0 flex-1 flex-col items-center justify-center text-center text-balance'
		)
	}
}
