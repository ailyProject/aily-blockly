import { type NumberInput } from '@angular/cdk/coercion'
import { CdkMenu } from '@angular/cdk/menu'
import { Directive, inject, input, numberAttribute, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmDropdownMenu],hlm-dropdown-menu',
	hostDirectives: [CdkMenu],
	host: {
		'data-slot': 'dropdown-menu',
		'[attr.data-state]': '_state()',
		'[attr.data-side]': '_side()',
		'[style.--side-offset]': 'sideOffset()'
	}
})
export class HlmDropdownMenu {
	private readonly _host = inject(CdkMenu)

	protected readonly _state = signal('open')
	protected readonly _side = signal('top')

	public readonly sideOffset = input<number, NumberInput>(1, { transform: numberAttribute })

	constructor() {
		classes(
			() =>
				'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 my-[--spacing(var(--side-offset))] min-w-[8rem] origin-top overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md'
		)

		this.setSideWithDarkMagic()
		// this is a best effort, but does not seem to work currently
		// TODO: figure out a way for us to know the host is about to be closed. might not be possible with CDK
		this._host.closed.pipe(takeUntilDestroyed()).subscribe(() => this._state.set('closed'))
	}

	private setSideWithDarkMagic() {
		/**
		 * This is an ugly workaround to at least figure out the correct side of where a submenu
		 * will appear and set the attribute to the host accordingly
		 *
		 * First of all we take advantage of the menu stack not being aware of the root
		 * object immediately after it is added. This code executes before the root element is added,
		 * which means the stack is still empty and the peek method returns undefined.
		 */
		const isRoot = this._host.menuStack.peek() === undefined
		setTimeout(() => {
			// our menu trigger directive leaves the last position used for use immediately after opening
			// we can access it here and determine the correct side.
			// eslint-disable-next-line
			const ps = (this._host as any)._parentTrigger._spartanLastPosition
			if (!ps) {
				// if we have no last position we default to the most likely option
				// I hate that we have to do this and hope we can revisit soon and improve
				this._side.set(isRoot ? 'top' : 'left')
				return
			}
			const side = isRoot ? ps.originY : ps.originX === 'end' ? 'right' : 'left'
			this._side.set(side)
		})
	}
}
