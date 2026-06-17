import { Directive, input } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'
import { cva } from 'class-variance-authority'

import { injectHlmItemMediaConfig } from './hlm-item-token'

import type { VariantProps } from 'class-variance-authority'

const itemMediaVariants = cva(
	'gap-2 group-has-data-[slot=item-description]/item:translate-y-0.5 group-has-data-[slot=item-description]/item:self-start flex shrink-0 items-center justify-center [&_ng-icon]:pointer-events-none',
	{
		variants: {
			variant: {
				default: 'bg-transparent',
				icon: "[&_ng-icon:not([class*='text-'])]:text-[calc(var(--spacing)*4)]",
				image:
					'size-10 overflow-hidden rounded-sm group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-6 [&_img]:size-full [&_img]:object-cover'
			}
		},
		defaultVariants: {
			variant: 'default'
		}
	}
)
export type ItemMediaVariants = VariantProps<typeof itemMediaVariants>

@Directive({
	selector: '[hlmItemMedia],hlm-item-media',
	host: {
		'data-slot': 'item-media',
		'[attr.data-variant]': 'variant()'
	}
})
export class HlmItemMedia {
	private readonly _config = injectHlmItemMediaConfig()
	public readonly variant = input<ItemMediaVariants['variant']>(this._config.variant)

	constructor() {
		classes(() => itemMediaVariants({ variant: this.variant() }))
	}
}
