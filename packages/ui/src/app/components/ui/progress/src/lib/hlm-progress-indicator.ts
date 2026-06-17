import { Directionality } from '@angular/cdk/bidi'
import { computed, Directive, inject } from '@angular/core'
import { BrnProgressIndicator, injectBrnProgress } from '@spartan-ng/brain/progress'
import { classes } from '@spartan-ng/helm/utils'

@Directive({
	selector: '[hlmProgressIndicator],hlm-progress-indicator',
	hostDirectives: [BrnProgressIndicator],
	host: { '[class.animate-indeterminate]': '_indeterminate()', '[style.transform]': '_transform()' }
})
export class HlmProgressIndicator {
	private readonly _progress = injectBrnProgress()
	private readonly _dir = inject(Directionality)
	// Offset the indicator by the unfilled remainder. In RTL the bar fills from the inline-start
	// (visually the right), so translate the opposite way to keep the fill on the correct side.
	protected readonly _transform = computed(() => {
		const offset = 100 - (this._progress.value() ?? 100)
		return `translateX(${this._dir.valueSignal() === 'rtl' ? '' : '-'}${offset}%)`
	})
	protected readonly _indeterminate = computed(
		() => this._progress.value() === null || this._progress.value() === undefined
	)

	constructor() {
		classes(() => 'bg-primary h-full w-full flex-1 transition-all')
	}
}
