import { Directive } from '@angular/core'
import { provideBrnDialogDefaultOptions } from '@spartan-ng/brain/dialog'
import { BrnPopover, provideBrnPopoverConfig } from '@spartan-ng/brain/popover'
import { BrnSelectMultiple } from '@spartan-ng/brain/select'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmSelectMultiple],hlm-select-multiple',
	providers: [
		provideBrnPopoverConfig({
			align: 'start',
			sideOffset: 6
		}),
		provideBrnDialogDefaultOptions({
			autoFocus: 'first-heading'
		})
	],
	hostDirectives: [
		{
			directive: BrnSelectMultiple,
			inputs: ['disabled', 'value', 'isItemEqualToValue', 'itemToString'],
			outputs: ['valueChange']
		},
		{
			directive: BrnPopover,
			inputs: [
				'align',
				'autoFocus',
				'closeDelay',
				'closeOnOutsidePointerEvents',
				'sideOffset',
				'state',
				'offsetX',
				'restoreFocus'
			],
			outputs: ['stateChanged', 'closed']
		}
	],
	host: { 'data-slot': 'select' }
})
export class HlmSelectMultiple {
	constructor() {
		classes(() => 'block')
	}
}
