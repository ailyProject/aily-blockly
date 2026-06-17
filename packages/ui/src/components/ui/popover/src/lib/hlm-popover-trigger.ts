import { Directive } from '@angular/core'
import { BrnPopoverTrigger } from '@spartan-ng/brain/popover'

@Directive({
	selector: 'button[hlmPopoverTrigger],button[hlmPopoverTriggerFor]',
	hostDirectives: [
		{ directive: BrnPopoverTrigger, inputs: ['id', 'brnPopoverTriggerFor: hlmPopoverTriggerFor', 'type'] }
	],
	host: {
		'data-slot': 'popover-trigger'
	}
})
export class HlmPopoverTrigger {}
