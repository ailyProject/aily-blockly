import { NumberInput } from '@angular/cdk/coercion'
import { Directive, input, numberAttribute } from '@angular/core'
import { BrnToggleGroup } from '@spartan-ng/brain/toggle-group'
import { ToggleVariants } from '@spartan-ng/helm/toggle'
import { classes } from '@spartan-ng/helm/utils'

import { provideHlmToggleGroup } from './hlm-toggle-group.token'

@Directive({
	selector: '[hlmToggleGroup],hlm-toggle-group',
	providers: [provideHlmToggleGroup(HlmToggleGroup)],
	hostDirectives: [
		{
			directive: BrnToggleGroup,
			inputs: ['type', 'value', 'nullable', 'disabled'],
			outputs: ['valueChange']
		}
	],
	host: {
		'data-slot': 'toggle-group',
		'[attr.data-variant]': 'variant()',
		'[attr.data-size]': 'size()',
		'[attr.data-spacing]': 'spacing()',
		'[attr.data-orientation]': 'orientation()',
		'[style.--gap]': 'spacing()'
	}
})
export class HlmToggleGroup {
	public readonly variant = input<ToggleVariants['variant']>('default')
	public readonly size = input<ToggleVariants['size']>('default')
	public readonly spacing = input<number, NumberInput>(0, { transform: numberAttribute })
	public readonly orientation = input<'horizontal' | 'vertical'>('horizontal')

	constructor() {
		classes(
			() =>
				'rounded-md data-[spacing=0]:data-[variant=outline]:shadow-xs group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] data-vertical:flex-col data-vertical:items-stretch'
		)
	}
}
