import {
	booleanAttribute,
	ChangeDetectionStrategy,
	Component,
	computed,
	forwardRef,
	input,
	linkedSignal,
	output
} from '@angular/core'
import { NG_VALUE_ACCESSOR } from '@angular/forms'
import { BrnSwitch, BrnSwitchThumb } from '@spartan-ng/brain/switch'
import { hlm } from 'spartan/utils'

import { HlmSwitchThumb } from './hlm-switch-thumb'

import type { BooleanInput } from '@angular/cdk/coercion'
import type { ControlValueAccessor } from '@angular/forms'
import type { ChangeFn, TouchFn } from '@spartan-ng/brain/forms'
import type { BrnSwitchSize } from '@spartan-ng/brain/switch'
import type { ClassValue } from 'clsx'

export const HLM_SWITCH_VALUE_ACCESSOR = {
	provide: NG_VALUE_ACCESSOR,
	useExisting: forwardRef(() => HlmSwitch),
	multi: true
}

@Component({
	selector: 'hlm-switch',
	imports: [BrnSwitchThumb, BrnSwitch, HlmSwitchThumb],
	providers: [HLM_SWITCH_VALUE_ACCESSOR],
	changeDetection: ChangeDetectionStrategy.OnPush,
	host: {
		class: 'contents',
		'[attr.aria-label]': 'null',
		'[attr.aria-labelledby]': 'null',
		'[attr.aria-describedby]': 'null'
	},
	template: `
		<brn-switch
			[class]="_computedClass()"
			[size]="size()"
			[checked]="checked()"
			(checkedChange)="handleChange($event)"
			(touched)="_onTouched?.()"
			[disabled]="_disabled()"
			[id]="inputId()"
			[aria-label]="ariaLabel()"
			[aria-labelledby]="ariaLabelledby()"
			[aria-describedby]="ariaDescribedby()"
		>
			<brn-switch-thumb hlm />
		</brn-switch>
	`
})
export class HlmSwitch implements ControlValueAccessor {
	public readonly userClass = input<ClassValue>('', { alias: 'class' })
	protected readonly _computedClass = computed(() =>
		hlm(
			'data-checked:bg-primary data-unchecked:bg-input focus-visible:border-ring focus-visible:ring-ring/50 data-[matches-spartan-invalid=true]:ring-destructive/20 dark:data-[matches-spartan-invalid=true]:ring-destructive/40 data-[matches-spartan-invalid=true]:border-destructive dark:data-[matches-spartan-invalid=true]:border-destructive/50 dark:data-unchecked:bg-input/80 rounded-full border border-transparent shadow-xs focus-visible:ring-3 data-[matches-spartan-invalid=true]:ring-3 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] group/switch inline-flex shrink-0 items-center transition-all outline-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50',
			this.userClass()
		)
	)

	/** The checked state of the switch. */
	public readonly checkedInput = input<boolean, BooleanInput>(false, { alias: 'checked', transform: booleanAttribute })
	public readonly checked = linkedSignal(this.checkedInput)

	/** Emits when the checked state of the switch changes. */
	public readonly checkedChange = output<boolean>()

	/** The disabled state of the switch. */
	public readonly disabled = input<boolean, BooleanInput>(false, {
		transform: booleanAttribute
	})

	/** The size of the switch. */
	public readonly size = input<BrnSwitchSize>('default')

	/** Used to set the id on the underlying brn element. */
	public readonly inputId = input<string | null>(null)

	/** Used to set the aria-label attribute on the underlying brn element. */
	public readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' })

	/** Used to set the aria-labelledby attribute on the underlying brn element. */
	public readonly ariaLabelledby = input<string | null>(null, { alias: 'aria-labelledby' })

	/** Used to set the aria-describedby attribute on the underlying brn element. */
	public readonly ariaDescribedby = input<string | null>(null, { alias: 'aria-describedby' })

	protected readonly _disabled = linkedSignal(this.disabled)

	protected _onChange?: ChangeFn<boolean>
	protected _onTouched?: TouchFn

	protected handleChange(value: boolean): void {
		this.checked.set(value)
		this._onChange?.(value)
		this.checkedChange.emit(value)
	}

	/** CONTROL VALUE ACCESSOR */
	writeValue(value: boolean): void {
		this.checked.set(Boolean(value))
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
