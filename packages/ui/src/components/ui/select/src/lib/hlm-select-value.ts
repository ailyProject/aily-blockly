import { Directive, inject } from '@angular/core'
import { BrnSelectValue } from '@spartan-ng/brain/select'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmSelectValue],hlm-select-value',
	hostDirectives: [{ directive: BrnSelectValue, inputs: ['placeholder'] }],
	host: { '[attr.data-slot]': '!_hidden() ? "select-value" : null' }
})
export class HlmSelectValue {
	private readonly _brnSelectValue = inject(BrnSelectValue)

	protected readonly _hidden = this._brnSelectValue.hidden

	constructor() {
		classes(() => 'data-hidden:hidden')
	}
}
