import { Directive } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmEmptyContent],hlm-empty-content',
	host: { 'data-slot': 'empty-content' }
})
export class HlmEmptyContent {
	constructor() {
		classes(() => 'gap-4 text-sm flex w-full max-w-sm min-w-0 flex-col items-center text-balance')
	}
}
