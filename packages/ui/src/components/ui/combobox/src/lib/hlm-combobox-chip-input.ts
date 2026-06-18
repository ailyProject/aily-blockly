import { Directive } from '@angular/core'
import { BrnComboboxChipInput } from '@spartan-ng/brain/combobox'
import { classes } from 'spartan/utils'

@Directive({
	selector: 'input[hlmComboboxChipInput]',
	hostDirectives: [{ directive: BrnComboboxChipInput, inputs: ['id', 'aria-invalid'] }],
	host: { 'data-slot': 'combobox-chip-input' }
})
export class HlmComboboxChipInput {
	constructor() {
		classes(() => 'placeholder:text-muted-foreground min-w-16 flex-1 outline-none')
	}
}
