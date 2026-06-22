import { isPlatformBrowser } from '@angular/common'
import {
	DestroyRef,
	effect,
	ElementRef,
	HostAttributeToken,
	inject,
	Injector,
	PLATFORM_ID,
	runInInjectionContext
} from '@angular/core'

import { toClassList } from './hlm.class'
import {
	cleanupManager,
	handleTransitionSuppression,
	restoreManagerTransition,
	setupGlobalObserver,
	updateElement
} from './hlm.classes.manager'
import { ClassesOptions, elementClassManagers, nextSourceId, observedElements } from './hlm.classes.state'

import type { ClassValue } from 'clsx'

export function classes(computed: () => ClassValue[] | string, options: ClassesOptions = {}) {
	runInInjectionContext(options.injector ?? inject(Injector), () => {
		const elementRef = options.elementRef ?? inject(ElementRef)
		const platformId = inject(PLATFORM_ID)
		const destroyRef = inject(DestroyRef)
		const baseClasses = inject(new HostAttributeToken('class'), { optional: true })
		const element = elementRef.nativeElement
		const sourceId = nextSourceId()

		let manager = elementClassManagers.get(element)
		if (!manager) {
			const initialBaseClasses = new Set<string>()
			if (baseClasses) {
				toClassList(baseClasses).forEach(cls => initialBaseClasses.add(cls))
			}

			manager = {
				element,
				sources: new Map(),
				baseClasses: initialBaseClasses,
				isUpdating: false,
				nextOrder: 0,
				hasInitialized: false,
				restoreRafId: null,
				transitionsSuppressed: false,
				previousTransition: '',
				previousTransitionPriority: ''
			}
			elementClassManagers.set(element, manager)
			setupGlobalObserver(platformId)
			observedElements.add(element)

			if (isPlatformBrowser(platformId)) {
				manager.previousTransition = element.style.getPropertyValue('transition')
				manager.previousTransitionPriority = element.style.getPropertyPriority('transition')
				element.style.setProperty('transition', 'none', 'important')
				manager.transitionsSuppressed = true
			}
		}

		const sourceOrder = manager.nextOrder++
		function updateClasses(): void {
			const newClasses = toClassList(computed())
			manager!.sources.set(sourceId, {
				classes: new Set(newClasses),
				order: sourceOrder
			})

			updateElement(manager!)
			handleTransitionSuppression(manager!)
		}

		destroyRef.onDestroy(() => {
			restoreManagerTransition(manager!)
			manager!.sources.delete(sourceId)

			if (manager!.sources.size === 0) {
				cleanupManager(element)
			} else {
				updateElement(manager!)
			}
		})

		effect(updateClasses)
	})
}
