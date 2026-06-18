import {
	booleanAttribute,
	ChangeDetectionStrategy,
	Component,
	effect,
	ElementRef,
	inject,
	input,
	Renderer2,
	signal
} from '@angular/core'
import { provideIcons } from '@ng-icons/core'
import { lucideX } from '@ng-icons/lucide'
import { injectExposedSideProvider, injectExposesStateProvider } from '@spartan-ng/brain/core'
import { HlmButton } from 'spartan/button'
import { HlmIconImports } from 'spartan/icon'
import { classes } from 'spartan/utils'

import { HlmSheetClose } from './hlm-sheet-close'

import type { BooleanInput } from '@angular/cdk/coercion'

@Component({
	selector: 'hlm-sheet-content',
	imports: [HlmIconImports, HlmButton, HlmSheetClose],
	providers: [provideIcons({ lucideX })],
	changeDetection: ChangeDetectionStrategy.OnPush,
	host: {
		'data-slot': 'sheet-content',
		'[attr.data-side]': '_sideProvider.side()',
		'[attr.data-state]': 'state()'
	},
	template: `
		<ng-content />

		@if (showCloseButton()) {
			<button hlmBtn variant="ghost" size="icon-sm" class="absolute end-4 top-4" hlmSheetClose>
				<span class="sr-only">Close</span>
				<ng-icon hlm size="sm" name="lucideX" />
			</button>
		}
	`
})
export class HlmSheetContent {
	private readonly _stateProvider = injectExposesStateProvider({ host: true })
	protected readonly _sideProvider = injectExposedSideProvider({ host: true })
	public readonly state = this._stateProvider.state ?? signal('closed')
	private readonly _renderer = inject(Renderer2)
	private readonly _element = inject(ElementRef)

	public readonly showCloseButton = input<boolean, BooleanInput>(true, { transform: booleanAttribute })

	constructor() {
		classes(() => [
			'bg-popover text-popover-foreground fixed flex flex-col gap-4 bg-clip-padding text-sm shadow-lg transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm',
			'data-open:animate-in data-closed:animate-out',
			'data-[side=top]:data-closed:slide-out-to-top data-[side=top]:data-open:slide-in-from-top',
			'data-[side=bottom]:data-closed:slide-out-to-bottom data-[side=bottom]:data-open:slide-in-from-bottom',
			'data-[side=left]:data-closed:slide-out-to-left data-[side=left]:data-open:slide-in-from-left',
			'data-[side=right]:data-closed:slide-out-to-right data-[side=right]:data-open:slide-in-from-right'
		])
		effect(() => {
			this._renderer.setAttribute(this._element.nativeElement, 'data-state', this.state())
		})
	}
}
