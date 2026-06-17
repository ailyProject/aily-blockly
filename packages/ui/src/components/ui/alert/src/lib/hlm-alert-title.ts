import { Directive } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmAlertTitle]',
	host: {
		'data-slot': 'alert-title'
	}
})
export class HlmAlertTitle {
	constructor() {
		classes(
			() =>
				'font-medium group-has-[>ng-icon]/alert:col-start-2 [&_a]:hover:text-foreground [&_a]:underline [&_a]:underline-offset-3'
		)
	}
}
