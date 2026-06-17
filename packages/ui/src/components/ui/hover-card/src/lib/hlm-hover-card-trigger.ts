import { Directive } from '@angular/core'
import { BrnHoverCardTrigger } from '@spartan-ng/brain/hover-card'

@Directive({
	selector: '[hlmHoverCardTrigger]',
	hostDirectives: [
		{
			directive: BrnHoverCardTrigger,
			inputs: [
				'showDelay',
				'hideDelay',
				'animationDelay',
				'sideOffset',
				'align',
				'brnHoverCardTriggerFor: hlmHoverCardTriggerFor'
			]
		}
	],
	host: {
		'data-slot': 'hover-card-trigger'
	}
})
export class HlmHoverCardTrigger {}
