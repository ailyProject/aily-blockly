import { Directive } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmButtonGroupText],hlm-button-group-text',
	host: {
		'data-slot': 'button-group-text'
	}
})
export class HlmButtonGroupText {
	constructor() {
		classes(
			() =>
				"bg-muted gap-2 rounded-md border px-2.5 text-sm font-medium shadow-xs [&_ng-icon:not([class*='text-'])]:text-[calc(var(--spacing)*4)] flex items-center [&_ng-icon]:pointer-events-none"
		)
	}
}
