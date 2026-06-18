import { ChangeDetectionStrategy, Component } from '@angular/core'
import { NgIcon, provideIcons } from '@ng-icons/core'
import { lucideCheck } from '@ng-icons/lucide'
import { classes } from 'spartan/utils'

@Component({
	selector: 'hlm-dropdown-menu-checkbox-indicator',
	imports: [NgIcon],
	providers: [provideIcons({ lucideCheck })],
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: ` <ng-icon class="text-base" name="lucideCheck" /> `
})
export class HlmDropdownMenuCheckboxIndicator {
	constructor() {
		classes(
			() =>
				'pointer-events-none absolute left-2 flex size-3.5 items-center justify-center opacity-0 group-data-[checked]:opacity-100'
		)
	}
}
