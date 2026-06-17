import { Directive, effect, EffectRef, inject, input, OnDestroy } from '@angular/core'
import { BrnFieldA11yService } from '@spartan-ng/brain/field'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmFieldDescription],hlm-field-description',
	host: {
		'data-slot': 'field-description',
		'[attr.id]': 'id()'
	}
})
export class HlmFieldDescription implements OnDestroy {
	private static _id = 0

	private readonly _a11y = inject(BrnFieldA11yService, { optional: true, host: true })

	public readonly id = input<string>(`hlm-field-description-${HlmFieldDescription._id++}`)

	private _registeredId?: string

	private readonly _cleanup: EffectRef | null = this._a11y
		? effect(() => {
				const a11y = this._a11y
				if (!a11y) return

				const id = this.id()
				if (this._registeredId && this._registeredId !== id) {
					a11y.unregisterDescription(this._registeredId)
				}

				if (this._registeredId !== id) {
					a11y.registerDescription(id)
					this._registeredId = id
				}
			})
		: null

	constructor() {
		classes(() => [
			'text-muted-foreground text-start text-sm [[data-variant=legend]+&]:-mt-1.5 leading-normal font-normal group-has-data-horizontal/field:text-balance',
			'last:mt-0 nth-last-2:-mt-1',
			'[&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4'
		])
	}

	ngOnDestroy() {
		this._cleanup?.destroy()

		if (this._registeredId) {
			this._a11y?.unregisterDescription(this._registeredId)
		}
	}
}
