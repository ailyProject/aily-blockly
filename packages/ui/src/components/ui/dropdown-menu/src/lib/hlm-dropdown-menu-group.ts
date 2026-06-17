import { CdkMenuGroup } from '@angular/cdk/menu'
import { Directive } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmDropdownMenuGroup],hlm-dropdown-menu-group',
	hostDirectives: [CdkMenuGroup],
	host: {
		'data-slot': 'dropdown-menu-group'
	}
})
export class HlmDropdownMenuGroup {
	constructor() {
		classes(() => 'block')
	}
}
