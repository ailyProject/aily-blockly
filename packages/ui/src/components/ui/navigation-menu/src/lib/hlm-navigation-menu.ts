import { Directive } from '@angular/core'
import { BrnNavigationMenu } from '@spartan-ng/brain/navigation-menu'
import { classes } from 'spartan/utils'

@Directive({
	selector: 'nav[hlmNavigationMenu]',
	hostDirectives: [
		{
			directive: BrnNavigationMenu,
			inputs: ['value', 'delayDuration', 'skipDelayDuration', 'orientation', 'openOn'],
			outputs: ['valueChange']
		}
	]
})
export class HlmNavigationMenu {
	constructor() {
		classes(() => 'group/navigation-menu relative flex max-w-max flex-1 items-center justify-center')
	}
}
