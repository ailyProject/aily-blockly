import { Directive } from '@angular/core'
import { BrnComboboxMultiple } from '@spartan-ng/brain/combobox'
import { provideBrnDialogDefaultOptions } from '@spartan-ng/brain/dialog'
import { BrnPopover, provideBrnPopoverConfig } from '@spartan-ng/brain/popover'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmComboboxMultiple],hlm-combobox-multiple',
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
			directive: BrnComboboxMultiple,
			inputs: [
				'autoHighlight',
				'disabled',
				'filter',
				'search',
				'value',
				'itemToString',
				'filterOptions',
				'isItemEqualToValue'
			],
			outputs: ['searchChange', 'valueChange']
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
	host: { 'data-slot': 'combobox' }
})
export class HlmComboboxMultiple {
	constructor() {
		classes(() => 'block')
	}
}
