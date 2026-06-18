import { booleanAttribute, ChangeDetectionStrategy, Component, computed, input, numberAttribute } from '@angular/core'
import { NgIcon, provideIcons } from '@ng-icons/core'
import { lucideCircleCheck, lucideInfo, lucideLoader2, lucideOctagonX, lucideTriangleAlert } from '@ng-icons/lucide'
import { BrnSonnerImports } from '@spartan-ng/brain/sonner'
import { hlm } from 'spartan/utils'

import type { BooleanInput, NumberInput } from '@angular/cdk/coercion'
import type { ToasterProps } from '@spartan-ng/brain/sonner'
import type { ClassValue } from 'clsx'

@Component({
	selector: 'hlm-toaster',
	imports: [BrnSonnerImports, NgIcon],
	providers: [provideIcons({ lucideCircleCheck, lucideInfo, lucideTriangleAlert, lucideOctagonX, lucideLoader2 })],
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: `
		<brn-sonner-toaster
			[class]="_computedClass()"
			[invert]="invert()"
			[theme]="theme()"
			[position]="position()"
			[hotKey]="hotKey()"
			[richColors]="richColors()"
			[expand]="expand()"
			[duration]="duration()"
			[visibleToasts]="visibleToasts()"
			[closeButton]="closeButton()"
			[toastOptions]="_computedToastOptions()"
			[offset]="offset()"
			[style]="userStyle()"
		>
			<ng-template #loadingIcon>
				<ng-icon name="lucideLoader2" class="overflow-visible! text-base [&>svg]:motion-safe:animate-spin" />
			</ng-template>
			<ng-template #successIcon>
				<ng-icon name="lucideCircleCheck" class="overflow-visible! text-base" />
			</ng-template>
			<ng-template #errorIcon>
				<ng-icon name="lucideOctagonX" class="overflow-visible! text-base" />
			</ng-template>
			<ng-template #infoIcon>
				<ng-icon name="lucideInfo" class="overflow-visible! text-base" />
			</ng-template>
			<ng-template #warningIcon>
				<ng-icon name="lucideTriangleAlert" class="overflow-visible! text-base" />
			</ng-template>
		</brn-sonner-toaster>
	`
})
export class HlmToaster {
	public readonly invert = input<ToasterProps['invert'], BooleanInput>(false, {
		transform: booleanAttribute
	})
	public readonly theme = input<ToasterProps['theme']>('light')
	public readonly position = input<ToasterProps['position']>('bottom-right')
	public readonly hotKey = input<ToasterProps['hotkey']>(['altKey', 'KeyT'])
	public readonly richColors = input<ToasterProps['richColors'], BooleanInput>(false, {
		transform: booleanAttribute
	})
	public readonly expand = input<ToasterProps['expand'], BooleanInput>(false, {
		transform: booleanAttribute
	})
	public readonly duration = input<ToasterProps['duration'], NumberInput>(4000, {
		transform: numberAttribute
	})
	public readonly visibleToasts = input<ToasterProps['visibleToasts'], NumberInput>(3, {
		transform: numberAttribute
	})
	public readonly closeButton = input<ToasterProps['closeButton'], BooleanInput>(false, {
		transform: booleanAttribute
	})
	public readonly toastOptions = input<ToasterProps['toastOptions']>({})

	protected readonly _computedToastOptions = computed(() => {
		const options = this.toastOptions()
		return {
			...options,
			classes: {
				...options?.classes,
				toast: hlm('rounded-2xl!', options?.classes?.toast)
			}
		}
	})
	public readonly offset = input<ToasterProps['offset']>(null)
	public readonly userClass = input<ClassValue>('', { alias: 'class' })
	public readonly userStyle = input<Record<string, string>>(
		{
			'--normal-bg': 'var(--popover)',
			'--normal-text': 'var(--popover-foreground)',
			'--normal-border': 'var(--border)',
			'--border-radius': 'var(--radius)'
		},
		{ alias: 'style' }
	)

	protected readonly _computedClass = computed(() => hlm('toaster group', this.userClass()))
}
