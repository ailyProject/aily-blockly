import { Directive } from '@angular/core'
import { BrnDialogTrigger } from '@spartan-ng/brain/dialog'

@Directive({
	selector: 'button[hlmDialogTrigger],button[hlmDialogTriggerFor]',
	hostDirectives: [{ directive: BrnDialogTrigger, inputs: ['id', 'brnDialogTriggerFor: hlmDialogTriggerFor', 'type'] }],
	host: { 'data-slot': 'dialog-trigger' }
})
export class HlmDialogTrigger {}
