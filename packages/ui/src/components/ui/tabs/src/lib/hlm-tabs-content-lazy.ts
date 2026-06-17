import { Directive } from '@angular/core'
import { BrnTabsContentLazy } from '@spartan-ng/brain/tabs'

@Directive({
	selector: 'ng-template[hlmTabsContentLazy]',
	hostDirectives: [BrnTabsContentLazy]
})
export class HlmTabsContentLazy {}
