import { Directive } from '@angular/core'
import { BrnNavigationMenuTrigger } from '@spartan-ng/brain/navigation-menu'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: 'button[hlmNavigationMenuTrigger]',
	hostDirectives: [BrnNavigationMenuTrigger]
})
export class HlmNavigationMenuTrigger {
	constructor() {
		classes(
			() =>
				'bg-background hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[state=open]:hover:bg-accent data-[state=open]:text-accent-foreground data-[state=open]:focus:bg-accent data-[state=open]:bg-accent/50 focus-visible:ring-ring/50 group inline-flex h-9 w-max items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50'
		)
	}
}
