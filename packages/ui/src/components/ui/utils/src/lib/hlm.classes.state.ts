import type { ElementRef, Injector } from '@angular/core'

export interface ElementClassManager {
	element: HTMLElement
	sources: Map<number, { classes: Set<string>; order: number }>
	baseClasses: Set<string>
	isUpdating: boolean
	nextOrder: number
	hasInitialized: boolean
	restoreRafId: number | null
	transitionsSuppressed: boolean
	previousTransition: string
	previousTransitionPriority: string
}

export interface ClassesOptions {
	elementRef?: ElementRef<HTMLElement>
	injector?: Injector
}

export const elementClassManagers = new WeakMap<HTMLElement, ElementClassManager>()
export let globalObserver: MutationObserver | null = null
export const observedElements = new Set<HTMLElement>()
export let sourceCounter = 0

export const nextSourceId = () => sourceCounter++

export const setGlobalObserver = (observer: MutationObserver | null) => {
	globalObserver = observer
}
