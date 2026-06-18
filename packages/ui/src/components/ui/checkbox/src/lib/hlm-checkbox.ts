import {
	booleanAttribute,
	ChangeDetectionStrategy,
	Component,
	computed,
	forwardRef,
	input,
	linkedSignal,
	model,
	output,
	viewChild
} from '@angular/core'
import { NG_VALUE_ACCESSOR } from '@angular/forms'
import { NgIcon, provideIcons } from '@ng-icons/core'
import { lucideCheck } from '@ng-icons/lucide'
import { BrnCheckbox } from '@spartan-ng/brain/checkbox'
import { BrnFieldControlDescribedBy } from '@spartan-ng/brain/field'
import { HlmIcon } from 'spartan/icon'
import { hlm } from 'spartan/utils'

import type { BooleanInput } from '@angular/cdk/coercion'
import type { ControlValueAccessor } from '@angular/forms'
import type { ChangeFn, TouchFn } from '@spartan-ng/brain/forms'
import type { ClassValue } from 'clsx'

export const HLM_CHECKBOX_VALUE_ACCESSOR = {
	provide: NG_VALUE_ACCESSOR,
	useExisting: forwardRef(() => HlmCheckbox),
	multi: true
}

@Component({
	selector: 'hlm-checkbox',
	imports: [BrnCheckbox, NgIcon, HlmIcon],
	providers: [HLM_CHECKBOX_VALUE_ACCESSOR],
	viewProviders: [provideIcons({ lucideCheck })],
	changeDetection: ChangeDetectionStrategy.OnPush,
	hostDirectives: [BrnFieldControlDescribedBy],
	host: {
		class: 'contents peer',
		'data-slot': 'checkbox',
		'[attr.aria-label]': 'null',
		'[attr.aria-labelledby]': 'null',
		'[attr.data-disabled]': '_disabled() ? "" : null'
	},
	template: `
		<brn-checkbox
			[id]="inputId()"
			[name]="name()"
			[class]="_computedClass()"
			[checked]="checked()"
			[(indeterminate)]="indeterminate"
			[disabled]="_disabled()"
			[required]="required()"
			[aria-label]="ariaLabel()"
			[aria-labelledby]="ariaLabelledby()"
			[aria-describedby]="ariaDescribedby()"
			[forceInvalid]="forceInvalid()"
			(checkedChange)="_handleChange($event)"
			(touched)="_onTouched?.()"
		>
			@if (checked() || indeterminate()) {
				<span class="flex items-center justify-center text-current transition-none">
					<ng-icon hlm size="14px" name="lucideCheck" />
				</span>
			}
		</brn-checkbox>
	`
})
export class HlmCheckbox implements ControlValueAccessor {
	public readonly userClass = input<ClassValue>('', { alias: 'class' })

	protected readonly _computedClass = computed(() =>
		hlm(
			'border-input dark:bg-input/30 data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary data-checked:border-primary data-[matches-spartan-invalid=true]:aria-checked:border-primary data-[matches-spartan-invalid=true]:border-destructive dark:data-[matches-spartan-invalid=true]:border-destructive/50 focus-visible:border-ring focus-visible:ring-ring/50 data-[matches-spartan-invalid=true]:ring-destructive/20 dark:data-[matches-spartan-invalid=true]:ring-destructive/40 flex size-4 items-center justify-center rounded-[4px] border shadow-xs transition-shadow group-has-disabled/field:opacity-50 focus-visible:ring-3 data-[matches-spartan-invalid=true]:ring-3 peer shrink-0 cursor-default outline-none disabled:cursor-not-allowed disabled:opacity-50',
			this.userClass(),
			this._errorStateClass()
		)
	)

	/** Used to set the id on the underlying brn element. */
	public readonly inputId = input<string | null>(null)

	/** Used to set the aria-label attribute on the underlying brn element. */
	public readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' })

	/** Used to set the aria-labelledby attribute on the underlying brn element. */
	public readonly ariaLabelledby = input<string | null>(null, { alias: 'aria-labelledby' })

	/** Used to set the aria-describedby attribute on the underlying brn element. */
	public readonly ariaDescribedby = input<string | null>(null, { alias: 'aria-describedby' })

	/** The checked state of the checkbox. */
	public readonly checkedInput = input<boolean, BooleanInput>(false, { alias: 'checked', transform: booleanAttribute })
	public readonly checked = linkedSignal(this.checkedInput)

	/** Emits when checked state changes. */
	public readonly checkedChange = output<boolean>()

	/**
	 * The indeterminate state of the checkbox.
	 * For example, a "select all/deselect all" checkbox may be in the indeterminate state when some but not all of its sub-controls are checked.
	 */
	public readonly indeterminate = model<boolean>(false)

	/** The name attribute of the checkbox. */
	public readonly name = input<string | null>(null)

	/** Whether the checkbox is required. */
	public readonly required = input<boolean, BooleanInput>(false, { transform: booleanAttribute })

	/** Whether the checkbox is disabled. */
	public readonly disabled = input<boolean, BooleanInput>(false, { transform: booleanAttribute })

	/** Whether to force the checkbox into an invalid state. */
	public readonly forceInvalid = input<boolean, BooleanInput>(false, { transform: booleanAttribute })

	protected readonly _disabled = linkedSignal(this.disabled)

	private readonly _brnCheckbox = viewChild.required(BrnCheckbox)

	private readonly _spartanInvalid = computed(() => this.forceInvalid() || this._brnCheckbox().spartanInvalid?.())
	protected readonly _errorStateClass = computed(() =>
		this._spartanInvalid()
			? 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40'
			: ''
	)

	protected _onChange?: ChangeFn<boolean>
	protected _onTouched?: TouchFn

	protected _handleChange(value: boolean): void {
		if (this._disabled()) return
		this.checked.set(value)
		this.checkedChange.emit(value)
		this._onChange?.(value)
	}

	/** CONTROL VALUE ACCESSOR */
	writeValue(value: boolean): void {
		this.checked.set(value)
	}

	registerOnChange(fn: ChangeFn<boolean>): void {
		this._onChange = fn
	}

	registerOnTouched(fn: TouchFn): void {
		this._onTouched = fn
	}

	setDisabledState(isDisabled: boolean): void {
		this._disabled.set(isDisabled)
	}
}
