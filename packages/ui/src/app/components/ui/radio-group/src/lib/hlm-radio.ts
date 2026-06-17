import { type BooleanInput } from '@angular/cdk/coercion'
import { isPlatformBrowser } from '@angular/common'
import {
	booleanAttribute,
	ChangeDetectionStrategy,
	Component,
	computed,
	DOCUMENT,
	effect,
	ElementRef,
	inject,
	input,
	output,
	PLATFORM_ID,
	Renderer2
} from '@angular/core'
import { BrnRadio, BrnRadioGroup } from '@spartan-ng/brain/radio-group'
import { hlm } from '@spartan-ng/helm/utils'

import type { BrnRadioChange } from '@spartan-ng/brain/radio-group'
import type { ClassValue } from 'clsx'

@Component({
	selector: 'hlm-radio',
	imports: [BrnRadio],
	changeDetection: ChangeDetectionStrategy.OnPush,
	host: {
		'[attr.aria-label]': 'null',
		'[attr.aria-labelledby]': 'null',
		'[attr.aria-describedby]': 'null',
		'[attr.data-disabled]': 'disabled() ? "" : null',
		'data-slot': 'radio-group-item'
	},
	template: `
		<brn-radio
			[id]="inputId()"
			[class]="_computedClass()"
			[value]="value()"
			[required]="required()"
			[disabled]="disabled()"
			[attr.aria-invalid]="_ariaInvalid() ? 'true' : null"
			[attr.data-invalid]="_ariaInvalid() ? 'true' : null"
			[attr.data-dirty]="_dirty() ? 'true' : null"
			[attr.data-touched]="_touched() ? 'true' : null"
			[attr.data-matches-spartan-invalid]="_groupSpartanInvalid() ? 'true' : null"
			[aria-label]="ariaLabel()"
			[aria-labelledby]="ariaLabelledby()"
			[aria-describedby]="ariaDescribedby()"
			(change)="change.emit($event)"
		>
			<ng-content select="[target],[indicator],hlm-radio-indicator" indicator />
			<ng-content />
		</brn-radio>
	`
})
export class HlmRadio<T = unknown> {
	private readonly _document = inject(DOCUMENT)
	private readonly _renderer = inject(Renderer2)
	private readonly _elementRef = inject(ElementRef)
	private readonly _isBrowser = isPlatformBrowser(inject(PLATFORM_ID))
	private readonly _radioGroup = inject(BrnRadioGroup, { optional: true })

	protected readonly _ariaInvalid = computed(() => this._radioGroup?.controlState?.()?.invalid)

	protected readonly _touched = computed(() => this._radioGroup?.controlState?.()?.touched)
	protected readonly _dirty = computed(() => this._radioGroup?.controlState?.()?.dirty)
	protected readonly _groupSpartanInvalid = computed(() => this._radioGroup?.controlState?.()?.spartanInvalid)

	protected readonly _errorStateClass = computed(() => (this._groupSpartanInvalid() ? 'text-destructive' : ''))

	public readonly userClass = input<ClassValue>('', { alias: 'class' })
	protected readonly _computedClass = computed(() =>
		hlm(
			'group relative flex items-center gap-x-3',
			'data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50',
			this.userClass(),
			this._errorStateClass()
		)
	)

	/** Used to set the id on the underlying brn element. */
	public readonly inputId = input<string | undefined>(undefined)

	/** Used to set the aria-label attribute on the underlying brn element. */
	public readonly ariaLabel = input<string | undefined>(undefined, { alias: 'aria-label' })

	/** Used to set the aria-labelledby attribute on the underlying brn element. */
	public readonly ariaLabelledby = input<string | undefined>(undefined, { alias: 'aria-labelledby' })

	/** Used to set the aria-describedby attribute on the underlying brn element. */
	public readonly ariaDescribedby = input<string | undefined>(undefined, { alias: 'aria-describedby' })

	/**
	 * The value this radio button represents.
	 */
	public readonly value = input.required<T>()

	/** Whether the checkbox is required. */
	public readonly required = input<boolean, BooleanInput>(false, { transform: booleanAttribute })

	/** Whether the checkbox is disabled. */
	public readonly disabled = input<boolean, BooleanInput>(false, { transform: booleanAttribute })

	/**
	 * Event emitted when the checked state of this radio button changes.
	 */
	// eslint-disable-next-line @angular-eslint/no-output-native
	public readonly change = output<BrnRadioChange<T>>()

	constructor() {
		effect(() => {
			const isDisabled = this.disabled()

			if (!this._elementRef.nativeElement || !this._isBrowser) return

			const labelElement =
				this._elementRef.nativeElement.closest('label') ??
				this._document.querySelector(`label[for="${this.inputId()}"]`)

			if (!labelElement) return
			this._renderer.setAttribute(labelElement, 'data-disabled', isDisabled ? 'true' : 'false')
		})
	}
}
