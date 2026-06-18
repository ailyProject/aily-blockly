import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmItemTitle],hlm-item-title',
	host: { 'data-slot': 'item-title' }
})
export class HlmItemTitle {
	constructor() {
		classes(() => 'gap-2 text-sm leading-snug font-medium underline-offset-4 line-clamp-1 flex w-fit items-center')
	}
}
