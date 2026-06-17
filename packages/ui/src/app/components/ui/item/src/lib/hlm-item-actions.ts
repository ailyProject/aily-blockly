import { Directive } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmItemActions],hlm-item-actions',
	host: { 'data-slot': 'item-actions' }
})
export class HlmItemActions {
	constructor() {
		classes(() => 'gap-2 flex items-center')
	}
}
