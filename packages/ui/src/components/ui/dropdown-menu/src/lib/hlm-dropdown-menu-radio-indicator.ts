import { ChangeDetectionStrategy, Component } from '@angular/core'
import { NgIcon, provideIcons } from '@ng-icons/core'
import { lucideCircle } from '@ng-icons/lucide'
import { classes } from 'spartan/utils'

@Component({
	selector: 'hlm-dropdown-menu-radio-indicator',
	imports: [NgIcon],
	providers: [provideIcons({ lucideCircle })],
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: ` <ng-icon name="lucideCircle" class="text-[0.5rem] *:[svg]:fill-current" /> `
})
export class HlmDropdownMenuRadioIndicator {
	constructor() {
		classes(
			() =>
				'pointer-events-none absolute start-2 flex size-3.5 items-center justify-center opacity-0 group-data-[checked]:opacity-100'
		)
	}
}
