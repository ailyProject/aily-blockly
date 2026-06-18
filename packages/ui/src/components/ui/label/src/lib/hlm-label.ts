import { Directive } from '@angular/core'
import { BrnLabel } from '@spartan-ng/brain/label'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmLabel]',
	hostDirectives: [{ directive: BrnLabel, inputs: ['id', 'for'] }],
	host: { 'data-slot': 'label' }
})
export class HlmLabel {
	constructor() {
		classes(
			() =>
				'gap-2 text-sm leading-none font-medium group-data-[disabled=true]:opacity-50 peer-disabled:opacity-50 flex items-center select-none group-data-[disabled=true]:pointer-events-none peer-disabled:cursor-not-allowed'
		)
	}
}
