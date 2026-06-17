import { Directive } from '@angular/core'
import { HlmLabel } from '@spartan-ng/helm/label'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmFieldLabel],hlm-field-label',
	hostDirectives: [HlmLabel],
	host: { 'data-slot': 'field-label' }
})
export class HlmFieldLabel {
	constructor() {
		classes(() => [
			'has-data-checked:bg-primary/5 has-data-checked:border-primary/30 dark:has-data-checked:border-primary/20 dark:has-data-checked:bg-primary/10 gap-2 leading-snug group-data-[disabled=true]/field:opacity-50 has-[>[data-slot=field]]:rounded-md has-[>[data-slot=field]]:border *:data-[slot=field]:p-3 group/field-label peer/field-label flex w-fit',
			'has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col'
		])
	}
}
