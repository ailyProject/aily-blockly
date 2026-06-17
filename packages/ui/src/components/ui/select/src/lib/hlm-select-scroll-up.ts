import { ChangeDetectionStrategy, Component } from '@angular/core'
import { NgIcon, provideIcons } from '@ng-icons/core'
import { lucideChevronUp } from '@ng-icons/lucide'
import { BrnSelectScrollUp } from '@spartan-ng/brain/select'
import { classes } from '@spartan-ng/helm/utils'

@Component({
	selector: 'hlm-select-scroll-up',
	imports: [NgIcon],
	providers: [provideIcons({ lucideChevronUp })],
	changeDetection: ChangeDetectionStrategy.OnPush,
	hostDirectives: [BrnSelectScrollUp],
	template: ` <ng-icon name="lucideChevronUp" /> `
})
export class HlmSelectScrollUp {
	constructor() {
		classes(
			() =>
				"bg-popover z-10 flex cursor-default items-center justify-center py-1 [&_ng-icon:not([class*='text-'])]:text-[calc(var(--spacing)*4)] sticky top-0 w-full data-hidden:hidden"
		)
	}
}
