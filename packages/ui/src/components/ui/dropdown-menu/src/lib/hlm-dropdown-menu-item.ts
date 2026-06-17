import { type BooleanInput } from '@angular/cdk/coercion'
import { CdkMenuItem } from '@angular/cdk/menu'
import { booleanAttribute, Directive, HOST_TAG_NAME, inject, input } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmDropdownMenuItem],hlm-dropdown-menu-item',
	hostDirectives: [
		{
			directive: CdkMenuItem,
			inputs: ['cdkMenuItemDisabled: disabled'],
			outputs: ['cdkMenuItemTriggered: triggered']
		}
	],
	host: {
		'data-slot': 'dropdown-menu-item',
		'[attr.disabled]': '_isButton && disabled() ? "" : null',
		'[attr.data-disabled]': 'disabled() ? "" : null',
		'[attr.data-variant]': 'variant()',
		'[attr.data-inset]': 'inset() ? "" : null'
	}
})
export class HlmDropdownMenuItem {
	protected readonly _isButton = inject(HOST_TAG_NAME) === 'button'

	public readonly disabled = input<boolean, BooleanInput>(false, { transform: booleanAttribute })

	public readonly variant = input<'default' | 'destructive'>('default')

	public readonly inset = input<boolean, BooleanInput>(false, {
		transform: booleanAttribute
	})

	constructor() {
		classes(
			() =>
				"hover:bg-accent focus-visible:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[ng-icon]:!text-destructive [&_ng-icon:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0 [&_svg:not([class*='text-'])]:text-base"
		)
	}
}
