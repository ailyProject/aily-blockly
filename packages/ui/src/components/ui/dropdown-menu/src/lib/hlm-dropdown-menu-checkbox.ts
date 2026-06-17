import { type BooleanInput } from '@angular/cdk/coercion'
import { CdkMenuItemCheckbox } from '@angular/cdk/menu'
import { booleanAttribute, Directive, inject, input } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmDropdownMenuCheckbox]',
	hostDirectives: [
		{
			directive: CdkMenuItemCheckbox,
			inputs: ['cdkMenuItemDisabled: disabled', 'cdkMenuItemChecked: checked'],
			outputs: ['cdkMenuItemTriggered: triggered']
		}
	],
	host: {
		'data-slot': 'dropdown-menu-checkbox-item',
		'[attr.data-disabled]': 'disabled() ? "" : null',
		'[attr.data-checked]': 'checked() ? "" : null'
	}
})
export class HlmDropdownMenuCheckbox {
	private readonly _cdkMenuItem = inject(CdkMenuItemCheckbox)
	public readonly checked = input<boolean, BooleanInput>(this._cdkMenuItem.checked, { transform: booleanAttribute })
	public readonly disabled = input<boolean, BooleanInput>(this._cdkMenuItem.disabled, { transform: booleanAttribute })

	constructor() {
		classes(
			() =>
				'hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground group relative flex w-full cursor-default items-center rounded-sm py-1.5 pr-2 pl-8 text-sm transition-colors outline-none select-none has-[>hlm-dropdown-menu-checkbox-indicator:last-child]:ps-2 has-[>hlm-dropdown-menu-checkbox-indicator:last-child]:pe-8 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 has-[>hlm-dropdown-menu-checkbox-indicator:last-child]:[&>hlm-dropdown-menu-checkbox-indicator]:start-auto has-[>hlm-dropdown-menu-checkbox-indicator:last-child]:[&>hlm-dropdown-menu-checkbox-indicator]:end-2'
		)
	}
}
