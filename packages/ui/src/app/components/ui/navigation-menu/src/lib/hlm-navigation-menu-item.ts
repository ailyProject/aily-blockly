import { Directive } from '@angular/core'
import { BrnNavigationMenuItem } from '@spartan-ng/brain/navigation-menu'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: 'li[hlmNavigationMenuItem]',
	hostDirectives: [{ directive: BrnNavigationMenuItem, inputs: ['id'] }]
})
export class HlmNavigationMenuItem {
	constructor() {
		classes(() => 'relative')
	}
}
