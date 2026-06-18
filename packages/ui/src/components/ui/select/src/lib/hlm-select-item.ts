import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { NgIcon, provideIcons } from '@ng-icons/core'
import { lucideCheck } from '@ng-icons/lucide'
import { BrnSelectItem } from '@spartan-ng/brain/select'
import { classes } from 'spartan/utils'

@Component({
	selector: 'hlm-select-item',
	imports: [NgIcon],
	providers: [provideIcons({ lucideCheck })],
	changeDetection: ChangeDetectionStrategy.OnPush,
	hostDirectives: [{ directive: BrnSelectItem, inputs: ['id', 'disabled', 'value'] }],
	host: { 'data-slot': 'select-item' },
	template: `
		<ng-content />
		@if (_active()) {
			<ng-icon
				name="lucideCheck"
				class="absolute end-2 flex items-center justify-center text-[calc(var(--spacing)*4)]"
				aria-hidden="true"
			/>
		}
	`
})
export class HlmSelectItem {
	private readonly _brnSelectItem = inject(BrnSelectItem)

	protected readonly _active = this._brnSelectItem.active

	constructor() {
		classes(
			() =>
				'data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground gap-2 rounded-sm py-1.5 ps-2 pe-8 text-sm *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2 relative flex w-full cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0'
		)
	}
}
