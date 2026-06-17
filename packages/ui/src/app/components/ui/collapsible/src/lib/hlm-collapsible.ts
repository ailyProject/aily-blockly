import { Directive } from '@angular/core'
import { BrnCollapsible } from '@spartan-ng/brain/collapsible'

@Directive({
	selector: '[hlmCollapsible],hlm-collapsible',
	hostDirectives: [
		{
			directive: BrnCollapsible,
			inputs: ['expanded', 'disabled'],
			outputs: ['expandedChange']
		}
	],
	host: { 'data-slot': 'collapsible' }
})
export class HlmCollapsible {}
