import { Directive, input } from '@angular/core'
import { BrnTabsList } from '@spartan-ng/brain/tabs'
import { cva } from 'class-variance-authority'
import { classes } from 'spartan/utils'

import type { VariantProps } from 'class-variance-authority'

export const listVariants = cva(
	'rounded-lg p-[3px] group-data-horizontal/tabs:h-9 data-[variant=line]:rounded-none group/tabs-list text-muted-foreground inline-flex w-fit items-center justify-center group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col',
	{
		variants: {
			variant: {
				default: 'bg-muted',
				line: 'gap-1 bg-transparent'
			}
		},
		defaultVariants: {
			variant: 'default'
		}
	}
)
type ListVariants = VariantProps<typeof listVariants>

@Directive({
	selector: '[hlmTabsList],hlm-tabs-list',
	hostDirectives: [BrnTabsList],
	host: {
		'data-slot': 'tabs-list',
		'[attr.data-variant]': 'variant()'
	}
})
export class HlmTabsList {
	public readonly variant = input<ListVariants['variant']>('default')

	constructor() {
		classes(() => listVariants({ variant: this.variant() }))
	}
}
