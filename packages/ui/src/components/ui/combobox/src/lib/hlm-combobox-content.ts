import { Directive } from '@angular/core'
import { BrnComboboxContent } from '@spartan-ng/brain/combobox'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmComboboxContent],hlm-combobox-content',
	hostDirectives: [BrnComboboxContent]
})
export class HlmComboboxContent {
	constructor() {
		classes(() => [
			'bg-popover text-popover-foreground data-open:animate-in **:has-[[data-slot=input-group-control]:focus-visible]:border-input data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 **:data-[slot=input-group]:bg-input/30 **:data-[slot=input-group]:border-input/30 max-h-72 min-w-36 overflow-hidden rounded-md shadow-md ring-1 duration-100 **:has-[[data-slot=input-group-control]:focus-visible]:ring-0 **:data-[slot=input-group]:m-1 **:data-[slot=input-group]:mb-0 **:data-[slot=input-group]:h-8 **:data-[slot=input-group]:shadow-none group/combobox-content relative flex w-(--brn-combobox-width) flex-col p-0'
		])
	}
}
