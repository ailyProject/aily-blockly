import { computed, Directive, effect, input, untracked } from '@angular/core'
import { injectCustomClassSettable } from '@spartan-ng/brain/core'
import { BrnDialogOverlay } from '@spartan-ng/brain/dialog'
import { hlm } from '@spartan-ng/helm/utils'

import type { ClassValue } from 'clsx'

export const hlmDialogOverlayClass = hlm(
	'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs'
)

@Directive({
	selector: '[hlmDialogOverlay],hlm-dialog-overlay',
	hostDirectives: [BrnDialogOverlay]
})
export class HlmDialogOverlay {
	private readonly _classSettable = injectCustomClassSettable({ optional: true, host: true })

	public readonly userClass = input<ClassValue>('', { alias: 'class' })
	protected readonly _computedClass = computed(() => hlm(hlmDialogOverlayClass, this.userClass()))

	constructor() {
		effect(() => {
			const newClass = this._computedClass()
			untracked(() => this._classSettable?.setClassToCustomElement(newClass))
		})
	}
}
