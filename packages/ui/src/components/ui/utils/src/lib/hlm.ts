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
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

import type { ClassValue } from 'clsx'

export function hlm(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}

// Global map to track class managers per element
const elementClassManagers = new WeakMap<HTMLElement, ElementClassManager>()
// Global mutation observer for all elements
let globalObserver: MutationObserver | null = null
const observedElements = new Set<HTMLElement>()

interface ElementClassManager {
	element: HTMLElement
	sources: Map<number, { classes: Set<string>; order: number }>
	baseClasses: Set<string>
	isUpdating: boolean
	nextOrder: number
	hasInitialized: boolean
	restoreRafId: number | null
	/** Transitions are suppressed until the first effect writes correct classes */
	transitionsSuppressed: boolean
	/** Original inline transition value to restore after suppression (empty string = none was set) */
	previousTransition: string
	/** Original inline transition priority to preserve !important when restoring */
	previousTransitionPriority: string
}

let sourceCounter = 0

/**
 * This function dynamically adds and removes classes for a given element without requiring
 * the a class binding (e.g. `[class]="..."`) which may interfere with other class bindings.
 *
 * 1. This will merge the existing classes on the element with the new classes.
 * 2. It will also remove any classes that were previously added by this function but are no longer present in the new classes.
 * 3. Multiple calls to this function on the same element will be merged efficiently.
 */
export function classes(computed: () => ClassValue[] | string, options: ClassesOptions = {}) {
	runInInjectionContext(options.injector ?? inject(Injector), () => {
		const elementRef = options.elementRef ?? inject(ElementRef)
		const platformId = inject(PLATFORM_ID)
		const destroyRef = inject(DestroyRef)
		const baseClasses = inject(new HostAttributeToken('class'), { optional: true })

		const element = elementRef.nativeElement

		// Create unique identifier for this source
		const sourceId = sourceCounter++

		// Get or create the class manager for this element
		let manager = elementClassManagers.get(element)

		if (!manager) {
			// Initialize base classes from variation (host attribute 'class')
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

			// Setup global observer if needed and register this element
			setupGlobalObserver(platformId)
			observedElements.add(element)

			// Suppress transitions until the first effect writes correct classes and
			// the browser has painted them. This prevents CSS transition animations
			// during hydration when classes change from SSR state to client state.
			if (isPlatformBrowser(platformId)) {
				manager.previousTransition = element.style.getPropertyValue('transition')
				manager.previousTransitionPriority = element.style.getPropertyPriority('transition')
				element.style.setProperty('transition', 'none', 'important')
				manager.transitionsSuppressed = true
			}
		}

		// Assign order once at registration time
		const sourceOrder = manager.nextOrder++

		function updateClasses(): void {
			// Get the new classes from the computed function
			const newClasses = toClassList(computed())

			// Update this source's classes, keeping the original order
			manager!.sources.set(sourceId, {
				classes: new Set(newClasses),
				order: sourceOrder
			})

			// Update the element
			updateElement(manager!)

			// Re-enable transitions after the first effect writes correct classes.
			// Deferred to next animation frame so the browser paints the class change
			// with transitions disabled first, then re-enables them.
			if (manager!.transitionsSuppressed) {
				manager!.transitionsSuppressed = false
				manager!.restoreRafId = requestAnimationFrame(() => {
					manager!.restoreRafId = null
					restoreTransitionSuppression(manager!)
				})
			}
		}

		// Register cleanup with DestroyRef
		destroyRef.onDestroy(() => {
			if (manager!.restoreRafId !== null) {
				cancelAnimationFrame(manager!.restoreRafId)
				manager!.restoreRafId = null
			}

			if (manager!.transitionsSuppressed) {
				manager!.transitionsSuppressed = false
				restoreTransitionSuppression(manager!)
			}

			// Remove this source from the manager
			manager!.sources.delete(sourceId)

			// If no more sources, clean up the manager
			if (manager!.sources.size === 0) {
				cleanupManager(element)
			} else {
				// Update element without this source's classes
				updateElement(manager!)
			}
		})

		/**
		 * We need this effect to track changes to the computed classes. Ideally, we would use
		 * afterRenderEffect here, but that doesn't run in SSR contexts, so we use a standard
		 * effect which works in both browser and SSR.
		 */
		effect(updateClasses)
	})
}

function restoreTransitionSuppression(manager: ElementClassManager): void {
	const prev = manager.previousTransition
	if (prev) {
		manager.element.style.setProperty('transition', prev, manager.previousTransitionPriority || undefined)
	} else {
		manager.element.style.removeProperty('transition')
	}
}

// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
function setupGlobalObserver(platformId: Object): void {
	if (isPlatformBrowser(platformId) && !globalObserver) {
		// Create single global observer that watches the entire document
		globalObserver = new MutationObserver(mutations => {
			for (const mutation of mutations) {
				if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
					const element = mutation.target as HTMLElement
					const manager = elementClassManagers.get(element)

					// Only process elements we're managing
					if (manager && observedElements.has(element)) {
						if (manager.isUpdating) continue // Ignore changes we're making

						// Update base classes to include any externally added classes
						const currentClasses = toClassList(element.className)
						const allSourceClasses = new Set<string>()

						// Collect all classes from all sources
						for (const source of manager.sources.values()) {
							for (const className of source.classes) {
								allSourceClasses.add(className)
							}
						}

						// Any classes not from sources become new base classes
						manager.baseClasses.clear()

						for (const className of currentClasses) {
							if (!allSourceClasses.has(className)) {
								manager.baseClasses.add(className)
							}
						}

						updateElement(manager)
					}
				}
			}
		})

		// Start observing the entire document for class attribute changes
		globalObserver.observe(document, {
			attributes: true,
			attributeFilter: ['class'],
			subtree: true // Watch all descendants
		})
	}
}

function updateElement(manager: ElementClassManager): void {
	if (manager.isUpdating) return // Prevent recursive updates

	manager.isUpdating = true

	// Handle initialization: capture base classes after first source registration
	if (!manager.hasInitialized && manager.sources.size > 0) {
		// Get current classes on element (may include SSR classes)
		const currentClasses = toClassList(manager.element.className)

		// Get all classes that will be applied by sources
		const allSourceClasses = new Set<string>()
		for (const source of manager.sources.values()) {
			source.classes.forEach(className => allSourceClasses.add(className))
		}

		// Only consider classes as "base" if they're not produced by any source
		// This prevents SSR-rendered classes from being preserved as base classes
		currentClasses.forEach(className => {
			if (!allSourceClasses.has(className)) {
				manager.baseClasses.add(className)
			}
		})

		manager.hasInitialized = true
	}

	// Get classes from all sources, sorted by registration order (later takes precedence)
	const sortedSources = Array.from(manager.sources.entries()).sort(([, a], [, b]) => a.order - b.order)

	const allSourceClasses: string[] = []
	for (const [, source] of sortedSources) {
		allSourceClasses.push(...source.classes)
	}

	// Combine base classes with all source classes, ensuring base classes take precedence
	const classesToApply =
		allSourceClasses.length > 0 || manager.baseClasses.size > 0
			? hlm([...allSourceClasses, ...manager.baseClasses])
			: ''

	// Apply the classes to the element
	if (manager.element.className !== classesToApply) {
		manager.element.className = classesToApply
	}

	manager.isUpdating = false
}

function cleanupManager(element: HTMLElement): void {
	// Remove from global tracking
	observedElements.delete(element)
	elementClassManagers.delete(element)

	// If no more elements being tracked, cleanup global observer
	if (observedElements.size === 0 && globalObserver) {
		globalObserver.disconnect()
		globalObserver = null
	}
}

interface ClassesOptions {
	elementRef?: ElementRef<HTMLElement>
	injector?: Injector
}

// Cache for parsed class lists to avoid repeated string operations
const classListCache = new Map<string, string[]>()

function toClassList(className: string | ClassValue[]): string[] {
	// For simple string inputs, use cache to avoid repeated parsing
	if (typeof className === 'string' && classListCache.has(className)) {
		return classListCache.get(className)!
	}

	const result = clsx(className)
		.split(' ')
		.filter(c => c.length > 0)

	// Cache string results, but limit cache size to prevent memory growth
	if (typeof className === 'string' && classListCache.size < 1000) {
		classListCache.set(className, result)
	}

	return result
}
