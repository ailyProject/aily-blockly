import { Directive } from '@angular/core'
import { BrnAlertDialogTrigger } from '@spartan-ng/brain/alert-dialog'

@Directive({
	selector: 'button[hlmAlertDialogTrigger],button[hlmAlertDialogTriggerFor]',
	hostDirectives: [
		{ directive: BrnAlertDialogTrigger, inputs: ['id', 'brnAlertDialogTriggerFor: hlmAlertDialogTriggerFor', 'type'] }
	],
	host: { 'data-slot': 'alert-dialog-trigger' }
})
export class HlmAlertDialogTrigger {}
