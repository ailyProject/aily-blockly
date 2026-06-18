import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmItemHeader],hlm-item-header',
	host: { 'data-slot': 'item-header' }
})
export class HlmItemHeader {
	constructor() {
		classes(() => 'gap-2 flex basis-full items-center justify-between')
	}
}
