import { ChangeDetectionStrategy, Component, input } from '@angular/core'
import { NgIcon, provideIcons } from '@ng-icons/core'
import { lucideLoader2 } from '@ng-icons/lucide'
import { classes } from 'spartan/utils'

@Component({
	selector: 'hlm-spinner',
	imports: [NgIcon],
	providers: [provideIcons({ lucideLoader2 })],
	changeDetection: ChangeDetectionStrategy.OnPush,
	host: {
		role: 'status',
		'[attr.aria-label]': 'ariaLabel()'
	},
	template: ` <ng-icon [name]="icon()" /> `
})
export class HlmSpinner {
	/**
	 * The name of the icon to be used as the spinner.
	 * Use provideIcons({ ... }) to register custom icons.
	 */
	public readonly icon = input<string>('lucideLoader2')

	/** Aria label for the spinner for accessibility. */
	public readonly ariaLabel = input<string>('Loading', { alias: 'aria-label' })

	constructor() {
		classes(() => 'inline-flex text-[calc(var(--spacing)*4)] motion-safe:animate-spin')
	}
}
