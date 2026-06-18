import { computed, Directive, effect, input, untracked } from '@angular/core'
import { BrnAlertDialogOverlay } from '@spartan-ng/brain/alert-dialog'
import { injectCustomClassSettable } from '@spartan-ng/brain/core'
import { hlm } from 'spartan/utils'

import type { ClassValue } from 'clsx'

@Directive({
	selector: '[hlmAlertDialogOverlay],hlm-alert-dialog-overlay',
	hostDirectives: [BrnAlertDialogOverlay]
})
export class HlmAlertDialogOverlay {
	private readonly _classSettable = injectCustomClassSettable({ optional: true, host: true })

	public readonly userClass = input<ClassValue>('', { alias: 'class' })
	protected readonly _computedClass = computed(() =>
		hlm(
			'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs',
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
