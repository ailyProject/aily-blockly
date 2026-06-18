import { BooleanInput } from '@angular/cdk/coercion'
import { booleanAttribute, computed, Directive, input } from '@angular/core'
import { BrnComboboxAnchor, BrnComboboxPopoverTrigger, injectBrnComboboxBase } from '@spartan-ng/brain/combobox'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmComboboxChips],hlm-combobox-chips',
	hostDirectives: [BrnComboboxAnchor, BrnComboboxPopoverTrigger],
	host: {
		'data-slot': 'combobox-chips',
		'[attr.data-matches-spartan-invalid]': '_spartanInvalid() ? "true" : null'
	}
})
export class HlmComboboxChips {
	private readonly _combobox = injectBrnComboboxBase()

	public readonly forceInvalid = input<boolean, BooleanInput>(false, { transform: booleanAttribute })

	protected readonly _spartanInvalid = computed(
		() => this.forceInvalid() || this._combobox.controlState?.()?.spartanInvalid
	)

	constructor() {
		classes(
			() =>
				'dark:bg-input/30 border-input focus-within:border-ring focus-within:ring-ring/50 data-[matches-spartan-invalid=true]:ring-destructive/20 dark:data-[matches-spartan-invalid=true]:ring-destructive/40 data-[matches-spartan-invalid=true]:border-destructive dark:data-[matches-spartan-invalid=true]:border-destructive/50 flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border bg-transparent bg-clip-padding px-2.5 py-1.5 text-sm shadow-xs transition-[color,box-shadow] focus-within:ring-3 has-data-[slot=combobox-chip]:px-1.5 data-[matches-spartan-invalid=true]:ring-3'
		)
	}
}
