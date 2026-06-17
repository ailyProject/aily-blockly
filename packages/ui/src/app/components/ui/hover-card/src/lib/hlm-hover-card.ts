import { Directive } from '@angular/core'
import { BrnHoverCard } from '@spartan-ng/brain/hover-card'

@Directive({
	selector: '[hlmHoverCard],hlm-hover-card',
	hostDirectives: [BrnHoverCard],
	host: {
		'data-slot': 'hover-card'
	}
})
export class HlmHoverCard {}
