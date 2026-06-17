import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { BrnResizableHandle } from '@spartan-ng/brain/resizable'
import { classes } from '@spartan-ng/helm/utils'

@Component({
	selector: 'hlm-resizable-handle',
	exportAs: 'hlmResizableHandle',
	changeDetection: ChangeDetectionStrategy.OnPush,
	hostDirectives: [{ directive: BrnResizableHandle, inputs: ['withHandle', 'disabled'] }],
	host: {
		'data-slot': 'resizable-handle'
	},
	template: `
		@if (_brnResizableHandle.withHandle()) {
			<div class="bg-border h-6 w-1 rounded-lg z-10 flex shrink-0"></div>
		}
	`
})
export class HlmResizableHandle {
	protected readonly _brnResizableHandle = inject(BrnResizableHandle)

	constructor() {
		classes(() => [
			'bg-border ring-offset-background focus-visible:ring-ring relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:outline-hidden data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:translate-x-0 data-[panel-group-direction=vertical]:after:-translate-y-1/2 [&[data-panel-group-direction=vertical]>div]:rotate-90',
			'data-[panel-group-direction=horizontal]:hover:cursor-ew-resize data-[panel-group-direction=vertical]:hover:cursor-ns-resize'
		])
	}
}
