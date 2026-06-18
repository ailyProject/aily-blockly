import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: 'brn-switch-thumb[hlm],[hlmSwitchThumb]'
})
export class HlmSwitchThumb {
	constructor() {
		classes(
			() =>
				'bg-background dark:data-unchecked:bg-foreground dark:data-checked:bg-primary-foreground rounded-full group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-unchecked:translate-x-0 data-checked:ltr:translate-x-[calc(100%-2px)] data-checked:rtl:-translate-x-[calc(100%-2px)] pointer-events-none block ring-0 transition-transform'
		)
	}
}
