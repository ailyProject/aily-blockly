import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmItemContent],hlm-item-content',
	host: { 'data-slot': 'item-content' }
})
export class HlmItemContent {
	constructor() {
		classes(() => 'gap-1 group-data-[size=xs]/item:gap-0 flex flex-1 flex-col [&+[data-slot=item-content]]:flex-none')
	}
}
