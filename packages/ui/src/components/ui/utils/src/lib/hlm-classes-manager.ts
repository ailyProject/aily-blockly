import { isPlatformBrowser } from '@angular/common'

import { hlm, toClassList } from './hlm-class'
import {
	ElementClassManager,
	elementClassManagers,
	globalObserver,
	observedElements,
	setGlobalObserver
} from './hlm-classes-state'

const restoreTransitionSuppression = (manager: ElementClassManager): void => {
	const prev = manager.previousTransition
	if (prev) {
		manager.element.style.setProperty('transition', prev, manager.previousTransitionPriority || undefined)
	} else {
		manager.element.style.removeProperty('transition')
	}
}

export const setupGlobalObserver = (platformId: object): void => {
	if (isPlatformBrowser(platformId) && !globalObserver) {
		const observer = new MutationObserver(mutations => {
			for (const mutation of mutations) {
				if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') continue

				const element = mutation.target as HTMLElement
				const manager = elementClassManagers.get(element)
				if (!manager || !observedElements.has(element) || manager.isUpdating) continue

				const currentClasses = toClassList(element.className)
				const allSourceClasses = new Set<string>()
				for (const source of manager.sources.values()) {
					for (const className of source.classes) {
						allSourceClasses.add(className)
					}
				}

				manager.baseClasses.clear()
				for (const className of currentClasses) {
					if (!allSourceClasses.has(className)) {
						manager.baseClasses.add(className)
					}
				}

				updateElement(manager)
			}
		})

		observer.observe(document, {
			attributes: true,
			attributeFilter: ['class'],
			subtree: true
		})
		setGlobalObserver(observer)
	}
}

export function updateElement(manager: ElementClassManager): void {
	if (manager.isUpdating) return

	manager.isUpdating = true
	if (!manager.hasInitialized && manager.sources.size > 0) {
		const currentClasses = toClassList(manager.element.className)
		const allSourceClasses = new Set<string>()
		for (const source of manager.sources.values()) {
			source.classes.forEach(className => allSourceClasses.add(className))
		}

		currentClasses.forEach(className => {
			if (!allSourceClasses.has(className)) {
				manager.baseClasses.add(className)
			}
		})

		manager.hasInitialized = true
	}

	const sortedSources = Array.from(manager.sources.entries()).sort(([, a], [, b]) => a.order - b.order)
	const allSourceClasses: string[] = []
	for (const [, source] of sortedSources) {
		allSourceClasses.push(...source.classes)
	}

	const classesToApply =
		allSourceClasses.length > 0 || manager.baseClasses.size > 0
			? hlm([...allSourceClasses, ...manager.baseClasses])
			: ''

	if (manager.element.className !== classesToApply) {
		manager.element.className = classesToApply
	}

	manager.isUpdating = false
}

export const cleanupManager = (element: HTMLElement) => {
	observedElements.delete(element)
	elementClassManagers.delete(element)

	if (observedElements.size === 0 && globalObserver) {
		globalObserver.disconnect()
		setGlobalObserver(null)
	}
}

export const handleTransitionSuppression = (manager: ElementClassManager) => {
	if (!manager.transitionsSuppressed) return

	manager.transitionsSuppressed = false
	manager.restoreRafId = requestAnimationFrame(() => {
		manager.restoreRafId = null
		restoreTransitionSuppression(manager)
	})
}

export const restoreManagerTransition = (manager: ElementClassManager) => {
	if (manager.restoreRafId !== null) {
		cancelAnimationFrame(manager.restoreRafId)
		manager.restoreRafId = null
	}

	if (manager.transitionsSuppressed) {
		manager.transitionsSuppressed = false
		restoreTransitionSuppression(manager)
	}
}
