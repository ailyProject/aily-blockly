import { Directive, effect, ElementRef, inject, Renderer2, signal } from '@angular/core'
import { injectExposedSideProvider, injectExposesStateProvider } from '@spartan-ng/brain/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmHoverCardContent],hlm-hover-card-content',
	host: {
		'data-slot': 'hover-card-content'
	}
})
export class HlmHoverCardContent {
	private readonly _renderer = inject(Renderer2)
	private readonly _element = inject(ElementRef)

	public readonly state = injectExposesStateProvider({ host: true }).state ?? signal('closed').asReadonly()
	public readonly side = injectExposedSideProvider({ host: true }).side ?? signal('bottom').asReadonly()

	constructor() {
		effect(() => {
			this._renderer.setAttribute(this._element.nativeElement, 'data-state', this.state())
			this._renderer.setAttribute(this._element.nativeElement, 'data-side', this.side())
		})

		classes(() => [
			'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground w-64 rounded-lg p-4 text-sm shadow-md ring-1 duration-100 z-50 outline-none',
			'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2'
		])
	}
}
