import { BooleanInput } from '@angular/cdk/coercion'
import {
	booleanAttribute,
	ChangeDetectionStrategy,
	Component,
	computed,
	effect,
	EffectRef,
	inject,
	input,
	OnDestroy
} from '@angular/core'
import { BrnField, BrnFieldA11yService } from '@spartan-ng/brain/field'
import { classes } from '@spartan-ng/helm/utils'

@Component({
	selector: 'hlm-field-error',
	changeDetection: ChangeDetectionStrategy.OnPush,
	host: {
		role: 'alert',
		'data-slot': 'field-error',
		'[attr.id]': 'id()',
		'[hidden]': '!_display()'
	},
	template: `
		@if (_display()) {
			<ng-content />
		}
	`
})
export class HlmFieldError implements OnDestroy {
	private static _id = 0

	private readonly _field = inject(BrnField, { optional: true })
	private readonly _a11y = inject(BrnFieldA11yService, { optional: true, host: true })

	private _registeredId?: string | undefined

	private readonly _hasParentField = !!this._field

	/** The unique ID for the field error. If none is supplied, it will be auto-generated. */
	public readonly id = input<string>(`hlm-field-error-${HlmFieldError._id++}`)

	/**
	 * The name of the specific validator error key to match (e.g. 'required').
	 * When omitted, the error is shown if any validation error is present.
	 */
	public readonly validator = input<string>()

	/** Forces the error message to be visible regardless of the control's validation state. */
	public readonly forceShow = input<boolean, BooleanInput>(false, { transform: booleanAttribute })

	protected readonly _display = computed(() => !this._hasParentField || this.forceShow() || this._hasError())

	protected readonly _hasError = computed(() => {
		const errors = this._field?.errors()
		if (!errors) return false

		const validator = this.validator()
		const spartanInvalid = this._field?.controlState()?.spartanInvalid

		if (!spartanInvalid) return false

		return validator ? validator in errors : Object.keys(errors).length > 0
	})

	private readonly _cleanup: EffectRef | null = this._a11y
		? effect(() => {
				const a11y = this._a11y
				if (!a11y) return

				const id = this.id()
				const hasError = this._hasError()

				if (this._registeredId && (this._registeredId !== id || !hasError)) {
					a11y.unregisterError(this._registeredId)
					this._registeredId = undefined
				}

				if (hasError && this._registeredId !== id) {
					a11y.registerError(id)
					this._registeredId = id
				}
			})
		: null

	constructor() {
		classes(() => 'text-destructive text-sm font-normal')
	}

	ngOnDestroy() {
		this._cleanup?.destroy()

		if (this._registeredId) {
			this._a11y?.unregisterError(this._registeredId)
		}
	}
}
