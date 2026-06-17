import { Directive } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmEmptyTitle]',
	host: { 'data-slot': 'empty-title' }
})
export class HlmEmptyTitle {
	constructor() {
		classes(() => 'text-lg font-medium tracking-tight')
	}
}
