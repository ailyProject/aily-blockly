import { CdkMenuBar } from '@angular/cdk/menu'
import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmMenubar],hlm-menubar',
	hostDirectives: [CdkMenuBar],
	host: {
		'data-slot': 'menubar'
	}
})
export class HlmMenubar {
	constructor() {
		classes(() => 'bg-background h-9 gap-1 rounded-md border p-1 shadow-xs flex items-center')
	}
}
