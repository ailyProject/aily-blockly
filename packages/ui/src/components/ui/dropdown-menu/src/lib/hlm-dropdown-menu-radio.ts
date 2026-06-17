import { type BooleanInput } from '@angular/cdk/coercion'
import { CdkMenuItemRadio } from '@angular/cdk/menu'
import { booleanAttribute, Directive, inject, input } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmDropdownMenuRadio]',
	hostDirectives: [
		{
			directive: CdkMenuItemRadio,
			inputs: ['cdkMenuItemDisabled: disabled', 'cdkMenuItemChecked: checked'],
			outputs: ['cdkMenuItemTriggered: triggered']
		}
	],
	host: {
		'data-slot': 'dropdown-menu-radio-item',
		'[attr.data-disabled]': 'disabled() ? "" : null',
		'[attr.data-checked]': 'checked() ? "" : null'
	}
})
export class HlmDropdownMenuRadio {
	private readonly _cdkMenuItem = inject(CdkMenuItemRadio)
	public readonly checked = input<boolean, BooleanInput>(this._cdkMenuItem.checked, { transform: booleanAttribute })
	public readonly disabled = input<boolean, BooleanInput>(this._cdkMenuItem.disabled, { transform: booleanAttribute })

	constructor() {
		classes(
			() =>
				'hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground group relative flex w-full cursor-default items-center rounded-sm py-1.5 ps-8 pe-2 text-sm transition-colors outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
		)
	}
}
