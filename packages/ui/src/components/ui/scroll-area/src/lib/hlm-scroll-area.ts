import { Directive } from '@angular/core'
import { provideScrollbarOptions } from 'ngx-scrollbar'
import { classes } from 'spartan/utils'

@Directive({
	selector: 'ng-scrollbar[hlm],ng-scrollbar[hlmScrollbar]',
	providers: [provideScrollbarOptions({ visibility: 'hover' })],
	host: {
		'data-slot': 'scroll-area',
		'[style.--scrollbar-thumb-color]': '"var(--border)"',
		'[style.--scrollbar-thumb-hover-color]': '"var(--border)"',
		'[style.--scrollbar-track-color]': '"transparent"',
		'[style.--scrollbar-track-thickness]': '"0.625rem"',
		'[style.--scrollbar-track-offset]': '"1.5px"'
	}
})
export class HlmScrollArea {
	constructor() {
		classes(() => 'rounded-md [--scrollbar-thumb-shape:9999px] block')
	}
}
