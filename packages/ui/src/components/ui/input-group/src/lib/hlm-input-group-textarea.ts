import { Directive } from '@angular/core'
import { HlmTextarea } from '@spartan-ng/helm/textarea'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: 'textarea[hlmInputGroupTextarea]',
	hostDirectives: [HlmTextarea],
	host: { 'data-slot': 'input-group-control' }
})
export class HlmInputGroupTextarea {
	constructor() {
		classes(
			() =>
				'rounded-none border-0 bg-transparent py-2 shadow-none ring-0 focus-visible:ring-0 data-[matches-spartan-invalid=true]:ring-0 dark:bg-transparent flex-1 resize-none'
		)
	}
}
