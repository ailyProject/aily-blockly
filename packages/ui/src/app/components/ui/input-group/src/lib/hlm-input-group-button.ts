import { Directive, input } from '@angular/core'
import { HlmButton, provideBrnButtonConfig } from '@spartan-ng/helm/button'
import { classes } from '@spartan-ng/helm/utils'
import { cva } from 'class-variance-authority'

import type { VariantProps } from 'class-variance-authority'

const inputGroupAddonVariants = cva('gap-2 text-sm flex items-center shadow-none', {
	variants: {
		size: {
			xs: "h-6 gap-1 rounded-[calc(var(--radius)-5px)] px-1.5 [&>ng-icon:not([class*='text-'])]:text-[calc(var(--spacing)*3.5)]",
			sm: '',
			'icon-xs': 'size-6 rounded-[calc(var(--radius)-5px)] p-0 has-[>ng-icon]:p-0',
			'icon-sm': 'size-8 p-0 has-[>ng-icon]:p-0'
		}
	},
	defaultVariants: {
		size: 'xs'
	}
})

type InputGroupAddonVariants = VariantProps<typeof inputGroupAddonVariants>

@Directive({
	selector: 'button[hlmInputGroupButton]',
	providers: [
		provideBrnButtonConfig({
			variant: 'ghost'
		})
	],
	hostDirectives: [
		{
			directive: HlmButton,
			inputs: ['variant']
		}
	],
	host: {
		'[attr.data-size]': 'size()',
		'[type]': 'type()'
	}
})
export class HlmInputGroupButton {
	public readonly size = input<InputGroupAddonVariants['size']>('xs')
	public readonly type = input<'button' | 'submit' | 'reset'>('button')

	constructor() {
		classes(() => inputGroupAddonVariants({ size: this.size() }))
	}
}
