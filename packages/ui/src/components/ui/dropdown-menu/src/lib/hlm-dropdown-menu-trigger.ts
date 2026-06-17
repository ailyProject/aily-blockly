import { CdkMenuTrigger } from '@angular/cdk/menu'
import { computed, Directive, effect, inject, input } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { createMenuPosition } from '@spartan-ng/brain/core'

import { injectHlmDropdownMenuConfig } from './hlm-dropdown-menu-token'

import type { MenuAlign, MenuSide } from '@spartan-ng/brain/core'

@Directive({
	selector: '[hlmDropdownMenuTrigger]',
	hostDirectives: [
		{
			directive: CdkMenuTrigger,
			inputs: ['cdkMenuTriggerFor: hlmDropdownMenuTrigger', 'cdkMenuTriggerData: hlmDropdownMenuTriggerData'],
			outputs: ['cdkMenuOpened: hlmDropdownMenuOpened', 'cdkMenuClosed: hlmDropdownMenuClosed']
		}
	],
	host: {
		'data-slot': 'dropdown-menu-trigger'
	}
})
export class HlmDropdownMenuTrigger {
	private readonly _cdkTrigger = inject(CdkMenuTrigger, { host: true })
	private readonly _config = injectHlmDropdownMenuConfig()

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
	}
}
