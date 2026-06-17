import { Directive } from '@angular/core'
import { BrnNavigationMenuContent } from '@spartan-ng/brain/navigation-menu'

@Directive({
	selector: '[hlmNavigationMenuPortal]',
	hostDirectives: [BrnNavigationMenuContent]
})
export class HlmNavigationMenuPortal {}
