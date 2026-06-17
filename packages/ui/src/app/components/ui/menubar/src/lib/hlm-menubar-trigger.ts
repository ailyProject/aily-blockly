import { type BooleanInput } from '@angular/cdk/coercion'
import { CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu'
import { booleanAttribute, computed, Directive, effect, inject, input } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { createMenuPosition } from '@spartan-ng/brain/core'
import { classes } from '@spartan-ng/helm/utils'

import { injectHlmMenubarConfig } from './hlm-menubar-token'

import type { MenuAlign, MenuSide } from '@spartan-ng/brain/core'

@Directive({
	selector: 'button[hlmMenubarTrigger]',
	hostDirectives: [
		{
			directive: CdkMenuItem,
			inputs: ['cdkMenuItemDisabled: disabled']
		},
		{
			directive: CdkMenuTrigger,
			inputs: ['cdkMenuTriggerFor: hlmMenubarTrigger', 'cdkMenuTriggerData: hlmMenubarTriggerData'],
			outputs: ['cdkMenuOpened: hlmDropdownMenuOpened', 'cdkMenuClosed: hlmDropdownMenuClosed']
		}
	],
	host: {
		'data-slot': 'menubar-trigger',
		'[disabled]': 'disabled() ',
		'[attr.data-disabled]': 'disabled() ? "" : null'
	}
})
export class HlmMenubarTrigger {
	private readonly _cdkTrigger = inject(CdkMenuTrigger, { host: true })
	private readonly _config = injectHlmMenubarConfig()

	public readonly disabled = input<boolean, BooleanInput>(false, { transform: booleanAttribute })

	public readonly align = input<MenuAlign>(this._config.align)
	public readonly side = input<MenuSide>(this._config.side)

	private readonly _menuPosition = computed(() => createMenuPosition(this.align(), this.side()))

	constructor() {
		// once the trigger opens we wait until the next tick and then grab the last position
		// used to position the menu. we store this in our trigger which the brnMenu directive has
		// access to through DI
		this._cdkTrigger.opened.pipe(takeUntilDestroyed()).subscribe(() =>
			setTimeout(
				() =>
					// eslint-disable-next-line
					((this._cdkTrigger as any)._spartanLastPosition = // eslint-disable-next-line
						(this._cdkTrigger as any).overlayRef._positionStrategy._lastPosition)
			)
		)

		effect(() => {
			this._cdkTrigger.menuPosition = this._menuPosition()
		})

		classes(
			() =>
				'hover:bg-muted aria-expanded:bg-muted rounded-sm px-2 py-1 text-sm font-medium flex items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50'
		)
	}
}
