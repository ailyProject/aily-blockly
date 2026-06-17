import { type BooleanInput } from '@angular/cdk/coercion'
import { booleanAttribute, Directive, input } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmDropdownMenuLabel],hlm-dropdown-menu-label',
	host: {
		'data-slot': 'dropdown-menu-label',
		'[attr.data-inset]': 'inset() ? "" : null'
	}
})
export class HlmDropdownMenuLabel {
	constructor() {
		classes(() => 'block px-2 py-1.5 text-sm font-medium data-[inset]:pl-8')
	}

	public readonly inset = input<boolean, BooleanInput>(false, {
		transform: booleanAttribute
	})
}
