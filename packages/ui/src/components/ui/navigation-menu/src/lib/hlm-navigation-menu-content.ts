import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmNavigationMenuContent],hlm-navigation-menu-content',
	host: { 'data-slot': 'navigation-menu-content' }
})
export class HlmNavigationMenuContent {
	constructor() {
		classes(() => [
			'data-[motion^=from-]:animate-in data-[motion^=to-]:animate-out data-[motion^=from-]:fade-in data-[motion^=to-]:fade-out top-0 left-0 w-full p-2 pr-2.5 md:w-auto',
			'data-[orientation=horizontal]:data-[motion=from-end]:slide-in-from-right-52 data-[orientation=horizontal]:data-[motion=from-start]:slide-in-from-left-52 data-[orientation=horizontal]:data-[motion=to-end]:slide-out-to-right-52 data-[orientation=horizontal]:data-[motion=to-start]:slide-out-to-left-52',
			'data-[orientation=vertical]:data-[motion=from-end]:slide-in-from-bottom-52 data-[orientation=vertical]:data-[motion=from-start]:slide-in-from-top-52 data-[orientation=vertical]:data-[motion=to-end]:slide-out-to-bottom-52 data-[orientation=vertical]:data-[motion=to-start]:slide-out-to-top-52',
			'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 top-full overflow-hidden rounded-md border shadow duration-200 data-[orientation=horizontal]:mt-1.5 data-[orientation=vertical]:mx-1.5 **:data-[slot=navigation-menu-link]:focus:ring-0 **:data-[slot=navigation-menu-link]:focus:outline-none'
		])
	}
}
