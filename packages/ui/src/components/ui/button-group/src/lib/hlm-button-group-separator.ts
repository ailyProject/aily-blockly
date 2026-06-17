import { Directive } from '@angular/core'
import { BrnSeparator, provideBrnSeparatorConfig } from '@spartan-ng/brain/separator'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmButtonGroupSeparator],hlm-button-group-separator',
	providers: [provideBrnSeparatorConfig({ orientation: 'vertical' })],
	hostDirectives: [{ directive: BrnSeparator, inputs: ['orientation', 'decorative'] }],
	host: {
		'data-slot': 'button-group-separator'
	}
})
export class HlmButtonGroupSeparator {
	constructor() {
		classes(() => [
			'bg-input relative self-stretch data-horizontal:mx-px data-horizontal:w-auto data-vertical:my-px data-vertical:h-auto',
			// separator classes
			'shrink-0 data-horizontal:h-px data-vertical:w-px data-vertical:self-stretch'
		])
	}
}
