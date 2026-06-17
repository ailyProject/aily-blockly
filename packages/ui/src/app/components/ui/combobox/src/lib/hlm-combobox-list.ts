import { Directive } from '@angular/core'
import { BrnComboboxList } from '@spartan-ng/brain/combobox'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmComboboxList]',
	hostDirectives: [{ directive: BrnComboboxList, inputs: ['id'] }],
	host: { 'data-slot': 'combobox-list' }
})
export class HlmComboboxList {
	constructor() {
		classes(
			() =>
				'no-scrollbar max-h-[calc(--spacing(72)---spacing(9))] scroll-py-1 p-1 data-empty:p-0 overflow-y-auto overscroll-contain'
		)
	}
}
