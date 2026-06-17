import { Directive, effect, ElementRef, inject, Renderer2, signal } from '@angular/core'
import { injectExposesStateProvider } from '@spartan-ng/brain/core'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmPopoverContent],hlm-popover-content'
})
export class HlmPopoverContent {
	private readonly _stateProvider = injectExposesStateProvider({ host: true })
	public state = this._stateProvider.state ?? signal('closed')
	private readonly _renderer = inject(Renderer2)
	private readonly _element = inject(ElementRef)

	constructor() {
		effect(() => {
			this._renderer.setAttribute(this._element.nativeElement, 'data-state', this.state())
		})

		classes(
			() =>
				'bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 gap-4 rounded-md p-4 text-sm shadow-md ring-1 duration-100 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative flex w-72 flex-col outline-none'
		)
	}
}
