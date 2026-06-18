import { computed, Directive, effect, input, untracked } from '@angular/core'
import { injectCustomClassSettable } from '@spartan-ng/brain/core'
import { BrnSheetOverlay } from '@spartan-ng/brain/sheet'
import { hlm } from 'spartan/utils'

import type { ClassValue } from 'clsx'

@Directive({
	selector: '[hlmSheetOverlay],hlm-sheet-overlay',
	hostDirectives: [BrnSheetOverlay]
})
export class HlmSheetOverlay {
	private readonly _classSettable = injectCustomClassSettable({ optional: true, host: true })
	public readonly userClass = input<ClassValue>('', { alias: 'class' })
	protected readonly _computedClass = computed(() =>
		hlm(
			'bg-black/10 supports-backdrop-filter:backdrop-blur-xs transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0',
			this.userClass()
		)
	)

	constructor() {
		effect(() => {
			const classValue = this._computedClass()
			untracked(() => this._classSettable?.setClassToCustomElement(classValue))
		})
	}
}
