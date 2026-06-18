import { Directive } from '@angular/core'
import { classes } from 'spartan/utils'

@Directive({
	selector: '[hlmSheetHeader],hlm-sheet-header',
	host: { 'data-slot': 'sheet-header' }
})
export class HlmSheetHeader {
	constructor() {
		classes(() => 'gap-1.5 p-4 flex flex-col')
	}
}
