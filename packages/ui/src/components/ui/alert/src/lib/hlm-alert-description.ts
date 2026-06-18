import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmAlertDescription]',
	host: {
		'data-slot': 'alert-description'
	}
})
export class HlmAlertDescription {
	constructor() {
		classes(
			() =>
				'text-muted-foreground text-sm text-balance md:text-pretty [&_p:not(:last-child)]:mb-4 [&_a]:hover:text-foreground [&_a]:underline [&_a]:underline-offset-3'
		)
	}
}
