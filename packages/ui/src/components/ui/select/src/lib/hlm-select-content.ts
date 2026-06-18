import { BooleanInput } from '@angular/cdk/coercion'
import { booleanAttribute, ChangeDetectionStrategy, Component, computed, input } from '@angular/core'
import { BrnSelectContent } from '@spartan-ng/brain/select'
import { classes, hlm } from 'spartan/utils'

import { HlmSelectScrollDown } from './hlm-select-scroll-down'
import { HlmSelectScrollUp } from './hlm-select-scroll-up'

@Component({
	selector: 'hlm-select-content',
	imports: [HlmSelectScrollUp, HlmSelectScrollDown],
	changeDetection: ChangeDetectionStrategy.OnPush,
	hostDirectives: [BrnSelectContent],
	template: `
		@if (showScroll()) {
			<hlm-select-scroll-up />
		}

		<div role="listbox" [class]="_computedListboxClasses()">
			<ng-content />
		</div>

		@if (showScroll()) {
			<hlm-select-scroll-down />
		}
	`
})
export class HlmSelectContent {
	protected readonly _computedListboxClasses = computed(() => hlm('flex flex-col'))

	public readonly showScroll = input<boolean, BooleanInput>(false, { transform: booleanAttribute })

	constructor() {
		classes(
			() =>
				'bg-popover no-scrollbar text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 max-h-72 min-w-36 flex-col rounded-md shadow-md ring-1 duration-100 relative flex w-(--brn-select-width) overflow-x-hidden overflow-y-auto'
		)
	}
}
