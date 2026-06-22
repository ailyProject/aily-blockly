import { Directive, input } from '@angular/core'
import { classes } from 'spartan/utils'

import { HlmCardConfig, injectHlmCardConfig } from './hlm-card-token'

@Directive({
	selector: '[hlmCard],hlm-card',
	host: {
		'data-slot': 'card',
		'[attr.data-size]': 'size()'
	}
})
export class HlmCard {
	private readonly _defaultConfig = injectHlmCardConfig()
	public readonly size = input<HlmCardConfig['size']>(this._defaultConfig.size)

	constructor() {
		classes(
			() =>
				'ring-foreground/10 bg-card text-card-foreground gap-(--card-spacing) overflow-hidden rounded-xl py-(--card-spacing) text-sm shadow-xs ring-1 [--card-spacing:--spacing(6)] has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl group/card flex flex-col'
		)
	}
}
