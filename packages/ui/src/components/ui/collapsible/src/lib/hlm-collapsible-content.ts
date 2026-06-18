import { Directive } from '@angular/core'
import { BrnCollapsibleContent } from '@spartan-ng/brain/collapsible'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmCollapsibleContent],hlm-collapsible-content',
	hostDirectives: [{ directive: BrnCollapsibleContent, inputs: ['id'] }],
	host: { 'data-slot': 'collapsible-content' }
})
export class HlmCollapsibleContent {
	constructor() {
		classes(() => 'data-[state=closed]:hidden')
	}
}
