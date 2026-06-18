import { Directive, input } from '@angular/core'
import { cva } from 'class-variance-authority'
import { classes } from 'spartan/utils'

import { injectHlmItemConfig } from './hlm-item-token'

import type { VariantProps } from 'class-variance-authority'

const itemVariants = cva(
	'[a]:hover:bg-muted rounded-md border text-sm group/item focus-visible:border-ring focus-visible:ring-ring/50 flex w-full flex-wrap items-center transition-colors duration-100 outline-none focus-visible:ring-[3px] [a]:transition-colors',
	{
		variants: {
			variant: {
				default: 'border-transparent',
				outline: 'border-border',
				muted: 'bg-muted/50 border-transparent'
			},
			size: {
				default: 'gap-3.5 px-4 py-3.5',
				sm: 'gap-2.5 px-3 py-2.5',
				xs: 'gap-2 px-2.5 py-2 in-data-[slot=dropdown-menu-content]:p-0'
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	}
)

export type ItemVariants = VariantProps<typeof itemVariants>

@Directive({
	selector: '[hlmItem],hlm-item',
	host: {
		'data-slot': 'item',
		'[attr.data-variant]': 'variant()',
		'[attr.data-size]': 'size()'
	}
})
export class HlmItem {
	private readonly _config = injectHlmItemConfig()
	public readonly variant = input<ItemVariants['variant']>(this._config.variant)
	public readonly size = input<ItemVariants['size']>(this._config.size)

	constructor() {
		classes(() => itemVariants({ variant: this.variant(), size: this.size() }))
	}
}
