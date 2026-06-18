import { Directive, input } from '@angular/core'
import { BrnDialogClose } from '@spartan-ng/brain/dialog'
import { HlmButton, provideBrnButtonConfig } from 'spartan/button'

@Directive({
	selector: 'button[hlmAlertDialogCancel]',
	providers: [provideBrnButtonConfig({ variant: 'outline' })],
	hostDirectives: [
		{ directive: BrnDialogClose, inputs: ['delay'] },
		{ directive: HlmButton, inputs: ['variant', 'size'] }
	],
	host: { 'data-slot': 'alert-dialog-cancel', '[type]': 'type()' }
})
export class HlmAlertDialogCancel {
	public readonly type = input<'button' | 'submit' | 'reset'>('button')
}
