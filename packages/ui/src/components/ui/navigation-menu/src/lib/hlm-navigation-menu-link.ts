import { Directive } from '@angular/core'
import { BrnNavigationMenuLink } from '@spartan-ng/brain/navigation-menu'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: 'a[hlmNavigationMenuLink]',
	hostDirectives: [{ directive: BrnNavigationMenuLink, inputs: ['active'] }]
})
export class HlmNavigationMenuLink {
	constructor() {
		classes(() => [
			'data-[active=true]:focus:bg-accent data-[active=true]:hover:bg-accent data-[active=true]:bg-accent/50 data-[active=true]:text-accent-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus-visible:ring-ring/50 [&_ng-icon:not([class*="text-"])]:text-muted-foreground flex flex-col gap-1 rounded-sm p-2 text-sm transition-all outline-none focus-visible:ring-[3px] focus-visible:outline-1 [&_ng-icon:not([class*="text-"])]:text-base',
			'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50'
		])
	}
}
