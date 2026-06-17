import { Directive } from '@angular/core'
import { BrnPopoverContent } from '@spartan-ng/brain/popover'

@Directive({
	selector: '[hlmComboboxPortal]',
	hostDirectives: [{ directive: BrnPopoverContent, inputs: ['context', 'class'] }]
})
export class HlmComboboxPortal {}
