import { computed, Directive, input } from '@angular/core'
import { BrnToggleGroupItem } from '@spartan-ng/brain/toggle-group'
import { toggleVariants, ToggleVariants } from '@spartan-ng/helm/toggle'
import { classes } from '@spartan-ng/helm/utils'

import { injectHlmToggleGroup } from './hlm-toggle-group.token'

@Directive({
	selector: 'button[hlmToggleGroupItem]',
	hostDirectives: [
		{
			directive: BrnToggleGroupItem,
			inputs: ['id', 'value', 'disabled', 'state', 'aria-label', 'type'],
			outputs: ['stateChange']
		}
	],
	host: {
		'data-slot': 'toggle-group-item',
		'[attr.data-variant]': '_variant()',
		'[attr.data-size]': '_size()',
		'[attr.data-spacing]': '_toggleGroup.spacing()'
	}
})
export class HlmToggleGroupItem {
	protected readonly _toggleGroup = injectHlmToggleGroup()

	public readonly variant = input<ToggleVariants['variant']>('default')
	public readonly size = input<ToggleVariants['size']>('default')

	protected readonly _variant = computed(() => this._toggleGroup.variant() || this.variant())
	protected readonly _size = computed(() => this._toggleGroup.size() || this.size())

	constructor() {
		classes(() => [
			'data-[state=on]:bg-muted group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 group-data-[spacing=0]/toggle-group:shadow-none group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-s-md group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-md group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-e-md group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-md shrink-0 focus:z-10 focus-visible:z-10 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-s-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-s group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t',
			toggleVariants({
				variant: this._variant(),
				size: this._size()
			})
		])
	}
}
