import { Directive } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmDropdownMenuSeparator],hlm-dropdown-menu-separator',
	host: {
		'data-slot': 'dropdown-menu-separator'
	}
})
export class HlmDropdownMenuSeparator {
	constructor() {
		classes(() => 'bg-border -mx-1 my-1 block h-px')
	}
}
