import { signal } from '@angular/core'

import {
	createCatalogLibraryViews,
	createDeclaredLibraryViews,
	createFilteredDeclaredLibraryViews,
	createFilteredMissingLibraries
} from './component.helpers'

import type {
	LibManagerActionOutput,
	LibManagerInstallPrompt,
	LibManagerLibraryScope,
	LibManagerLiveActionStatus,
	LibManagerPageState,
	LibManagerRegistryLibraryView,
	LibManagerVersionState
} from './types'

/**
 * 创建 lib-manager 页面本地状态与派生视图。
 */
export const createLibManagerPageState = () => {
	const state = signal<LibManagerPageState | null>(null)
	const loading = signal(true)
	const error = signal<string | null>(null)
	const actionBusyKey = signal<string | null>(null)
	const statusMessage = signal<string | null>(null)
	const npmRegistry = signal('')
	const registrySearchBusy = signal(false)
	const registrySearchResults = signal<Array<LibManagerRegistryLibraryView>>([])
	const lastActionOutput = signal<LibManagerActionOutput | null>(null)
	const liveActionStatus = signal<LibManagerLiveActionStatus | null>(null)
	const versionLoadingPackage = signal<string | null>(null)
	const libraryVersionsByPackage = signal<Record<string, LibManagerVersionState>>({})
	const libraryQuery = signal('')
	const libraryScope = signal<LibManagerLibraryScope>('all')
	const pendingInstallPrompt = signal<LibManagerInstallPrompt | null>(null)
	const declaredLibraryViews = createDeclaredLibraryViews(state)
	const filteredDeclaredLibraryViews = createFilteredDeclaredLibraryViews(
		declaredLibraryViews,
		libraryQuery,
		libraryScope
	)
	const filteredMissingLibraries = createFilteredMissingLibraries(state, libraryQuery, libraryScope)
	const catalogLibraryViews = createCatalogLibraryViews(state, libraryQuery, libraryScope)

	return {
		state,
		loading,
		error,
		actionBusyKey,
		statusMessage,
		npmRegistry,
		registrySearchBusy,
		registrySearchResults,
		lastActionOutput,
		liveActionStatus,
		versionLoadingPackage,
		libraryVersionsByPackage,
		libraryQuery,
		libraryScope,
		pendingInstallPrompt,
		declaredLibraryViews,
		filteredDeclaredLibraryViews,
		filteredMissingLibraries,
		catalogLibraryViews
	}
}
