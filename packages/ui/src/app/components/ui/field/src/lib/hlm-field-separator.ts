import { ChangeDetectionStrategy, Component } from '@angular/core'
import { HlmSeparator } from '@spartan-ng/helm/separator'
import { classes } from '@spartan-ng/helm/utils'

@Component({
	selector: 'hlm-field-separator',
	imports: [HlmSeparator],
	changeDetection: ChangeDetectionStrategy.OnPush,
	host: { 'data-slot': 'field-separator' },
	template: `
		<hlm-separator class="absolute inset-0 top-1/2" />
		<span
			data-slot="field-separator-content"
			class="text-muted-foreground px-2 bg-background relative mx-auto block w-fit"
		>
			<ng-content />
		</span>
	`
})
export class HlmFieldSeparator {
	constructor() {
		classes(() => '-my-2 h-5 text-sm group-data-[variant=outline]/field-group:-mb-2 relative')
	}
}
