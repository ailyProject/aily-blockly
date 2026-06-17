import { Directive } from '@angular/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: 'div[hlmTableContainer]',
	host: { 'data-slot': 'table-container' }
})
export class HlmTableContainer {
	constructor() {
		classes(() => 'relative w-full overflow-x-auto')
	}
}

/**
 * Directive to apply Shadcn-like styling to a <table> element.
 */
@Directive({
	selector: 'table[hlmTable]',
	host: { 'data-slot': 'table' }
})
export class HlmTable {
	constructor() {
		classes(() => 'w-full caption-bottom text-sm')
	}
}

/**
 * Directive to apply Shadcn-like styling to a <thead> element
 * within an HlmTable context.
 */
@Directive({
	selector: 'thead[hlmTHead],thead[hlmTableHeader]',
	host: { 'data-slot': 'table-header' }
})
export class HlmTHead {
	constructor() {
		classes(() => '[&_tr]:border-b')
	}
}

/**
 * Directive to apply Shadcn-like styling to a <tbody> element
 * within an HlmTable context.
 */
@Directive({
	selector: 'tbody[hlmTBody],tbody[hlmTableBody]',
	host: { 'data-slot': 'table-body' }
})
export class HlmTBody {
	constructor() {
		classes(() => '[&_tr:last-child]:border-0')
	}
}

/**
 * Directive to apply Shadcn-like styling to a <tfoot> element
 * within an HlmTable context.
 */
@Directive({
	selector: 'tfoot[hlmTFoot],tfoot[hlmTableFooter]',
	host: { 'data-slot': 'table-footer' }
})
export class HlmTFoot {
	constructor() {
		classes(() => 'bg-muted/50 border-t font-medium [&>tr]:last:border-b-0')
	}
}

/**
 * Directive to apply Shadcn-like styling to a <tr> element
 * within an HlmTable context.
 */
@Directive({
	selector: 'tr[hlmTr],tr[hlmTableRow]',
	host: { 'data-slot': 'table-row' }
})
export class HlmTr {
	constructor() {
		classes(
			() => 'hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors has-aria-expanded:bg-muted/50'
		)
	}
}

/**
 * Directive to apply Shadcn-like styling to a <th> element
 * within an HlmTable context.
 */
@Directive({
	selector: 'th[hlmTh],th[hlmTableHead]',
	host: { 'data-slot': 'table-head' }
})
export class HlmTh {
	constructor() {
		classes(
			() =>
				'text-foreground h-10 px-2 text-start align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pe-0'
		)
	}
}

/**
 * Directive to apply Shadcn-like styling to a <td> element
 * within an HlmTable context.
 */
@Directive({
	selector: 'td[hlmTd],td[hlmTableCell]',
	host: { 'data-slot': 'table-cell' }
})
export class HlmTd {
	constructor() {
		classes(() => 'p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pe-0')
	}
}

/**
 * Directive to apply Shadcn-like styling to a <caption> element
 * within an HlmTable context.
 */
@Directive({
	selector: 'caption[hlmCaption],caption[hlmTableCaption]',
	host: { 'data-slot': 'table-caption' }
})
export class HlmCaption {
	constructor() {
		classes(() => 'text-muted-foreground mt-4 text-sm')
	}
}
