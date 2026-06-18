import { Directive, input, signal } from '@angular/core'
import { injectExposesStateProvider } from '@spartan-ng/brain/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmAlertDialogContent],hlm-alert-dialog-content',
	host: {
		'data-slot': 'alert-dialog-content',
		'[attr.data-state]': 'state()',
		'[attr.data-size]': 'size()'
	}
})
export class HlmAlertDialogContent {
	private readonly _stateProvider = injectExposesStateProvider({ optional: true, host: true })
	public readonly state = this._stateProvider?.state ?? signal('closed')

	public readonly size = input<'sm' | 'default'>('default')

	constructor() {
		classes(
			() =>
				'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 bg-popover text-popover-foreground ring-foreground/10 gap-6 rounded-xl p-6 ring-1 duration-100 data-[size=default]:max-w-xs data-[size=sm]:max-w-xs data-[size=default]:sm:max-w-lg group/alert-dialog-content grid w-full outline-none'
		)
	}
}
