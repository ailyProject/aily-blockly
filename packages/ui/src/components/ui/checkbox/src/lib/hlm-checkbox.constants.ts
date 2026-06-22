import { forwardRef } from '@angular/core'
import { NG_VALUE_ACCESSOR } from '@angular/forms'

/**
 * Checkbox 组件的基础样式类。
 */
export const HLM_CHECKBOX_BASE_CLASS =
	'border-input dark:bg-input/30 data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary data-checked:border-primary data-[matches-spartan-invalid=true]:aria-checked:border-primary data-[matches-spartan-invalid=true]:border-destructive dark:data-[matches-spartan-invalid=true]:border-destructive/50 focus-visible:border-ring focus-visible:ring-ring/50 data-[matches-spartan-invalid=true]:ring-destructive/20 dark:data-[matches-spartan-invalid=true]:ring-destructive/40 flex size-4 items-center justify-center rounded-[4px] border shadow-xs transition-shadow group-has-disabled/field:opacity-50 focus-visible:ring-3 data-[matches-spartan-invalid=true]:ring-3 peer shrink-0 cursor-default outline-none disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Checkbox 组件宿主绑定。
 */
export const HLM_CHECKBOX_HOST = {
	class: 'contents peer',
	'data-slot': 'checkbox',
	'[attr.aria-label]': 'null',
	'[attr.aria-labelledby]': 'null',
	'[attr.data-disabled]': '_disabled() ? "" : null'
} as const

/**
 * Checkbox 组件模板。
 */
export const HLM_CHECKBOX_TEMPLATE = `
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

/**
 * 为 Checkbox 组件构造 ControlValueAccessor provider。
 * @param component - 目标组件构造函数
 */
export const createHlmCheckboxValueAccessor = (component: () => unknown) => ({
	provide: NG_VALUE_ACCESSOR,
	useExisting: forwardRef(component),
	multi: true
})
