import { Directive, input } from '@angular/core'
import { BrnTabs } from '@spartan-ng/brain/tabs'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmTabs],hlm-tabs',
	hostDirectives: [
		{
			directive: BrnTabs,
			inputs: ['orientation', 'activationMode', 'brnTabs: tab'],
			outputs: ['tabActivated']
		}
	],
	host: {
		'data-slot': 'tabs'
	}
})
export class HlmTabs {
	public readonly tab = input.required<string>()

	constructor() {
		classes(() => 'group/tabs flex gap-2 data-[orientation=horizontal]:flex-col')
	}
}
