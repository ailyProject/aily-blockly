import { NgComponentOutlet } from '@angular/common'
import { booleanAttribute, ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core'
import { provideIcons } from '@ng-icons/core'
import { lucideX } from '@ng-icons/lucide'
import { BrnDialogRef, injectBrnDialogContext } from '@spartan-ng/brain/dialog'
import { HlmButton } from '@spartan-ng/helm/button'
import { HlmIconImports } from '@spartan-ng/helm/icon'
import { classes } from '@spartan-ng/helm/utils'

import { HlmDialogClose } from './hlm-dialog-close'

import type { BooleanInput } from '@angular/cdk/coercion'

@Component({
	selector: 'hlm-dialog-content',
	imports: [NgComponentOutlet, HlmIconImports, HlmButton, HlmDialogClose],
	providers: [provideIcons({ lucideX })],
	changeDetection: ChangeDetectionStrategy.OnPush,
	host: {
		'data-slot': 'dialog-content',
		'[attr.data-state]': 'state()'
	},
	template: `
		@if (component) {
			<ng-container [ngComponentOutlet]="component" />
		} @else {
			<ng-content />
		}

		@if (showCloseButton()) {
			<button hlmBtn variant="ghost" size="icon-sm" class="absolute end-4 top-4" hlmDialogClose>
				<span class="sr-only">close</span>
				<ng-icon hlm size="sm" name="lucideX" />
			</button>
		}
	`
})
export class HlmDialogContent {
	private readonly _dialogRef = inject(BrnDialogRef)
	private readonly _dialogContext = injectBrnDialogContext({ optional: true })

	public readonly showCloseButton = input<boolean, BooleanInput>(this._dialogContext?.$showCloseButton ?? true, {
		transform: booleanAttribute
	})

	public readonly state = computed(() => this._dialogRef?.state() ?? 'closed')

	public readonly component = this._dialogContext?.$component
	private readonly _dynamicComponentClass = this._dialogContext?.$dynamicComponentClass

	constructor() {
		classes(() => [
			'bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 ring-foreground/10 grid max-w-[calc(100%-2rem)] gap-6 rounded-xl p-6 text-sm ring-1 duration-100 sm:max-w-md relative mx-auto w-full outline-none sm:mx-0',
			this._dynamicComponentClass
		])
	}
}
