import {
	confirmLibManagerInstallPrompt,
	focusLibManagerCoreLibraries,
	importLocalLibManagerLibrary,
	loadLibManagerVersions,
	refreshLibManagerPage,
	removeLibManagerLibrary,
	requestLibManagerRestore,
	searchLibManagerRegistry,
	selectLibManagerLibraryScope
} from './interactions'
import {
	isLibManagerScopeSelected,
	resolveLibManagerLiveActionLatestLine,
	resolveLibManagerLiveActionProgressPercent,
	shouldShowLibManagerCatalogSection,
	shouldShowLibManagerDeclaredSection,
	shouldShowLibManagerMissingSection
} from './runtime'

import type { Core } from '@/utils/core'
import type { Signal, WritableSignal } from '@angular/core'
import type {
	LibManagerActionContext,
	LibManagerLibraryScope,
	LibManagerLiveActionStatus,
	LibManagerPageState,
	LibManagerRegistryLibraryView,
	LibManagerVersionState
} from '../types'

/**
 * 创建 lib-manager 页面模板直接消费的交互句柄。
 * @param input - core、页面状态与 action context
 */
export const createLibManagerPageHandlers = (input: {
	core: Core
	state: WritableSignal<LibManagerPageState | null>
	loading: WritableSignal<boolean>
	error: WritableSignal<string | null>
	npmRegistry: WritableSignal<string>
	libraryScope: WritableSignal<LibManagerLibraryScope>
	libraryQuery: WritableSignal<string>
	actionBusyKey: Signal<string | null>
	pendingInstallPrompt: LibManagerActionContext['pendingInstallPrompt']
	registrySearchResults: WritableSignal<Array<LibManagerRegistryLibraryView>>
	libraryVersionsByPackage: Signal<Record<string, LibManagerVersionState>>
	catalogLibraryViews: Signal<Array<{ name: string }>>
	liveActionStatus: Signal<LibManagerLiveActionStatus | null>
	context: LibManagerActionContext
}) => ({
	refresh: () =>
		refreshLibManagerPage({
			core: input.core,
			setLoading: loading => input.loading.set(loading),
			setError: message => input.error.set(message),
			clearPendingInstallPrompt: () => input.pendingInstallPrompt.set(null),
			setState: state => input.state.set(state),
			setNpmRegistry: registry => input.npmRegistry.set(registry)
		}),
	requestRestoreLibrary: (packageName: string, version?: string, localPath?: string) =>
		requestLibManagerRestore({
			context: input.context,
			state: input.state(),
			setPendingInstallPrompt: prompt => input.pendingInstallPrompt.set(prompt),
			packageName,
			version,
			localPath
		}),
	importLocalLibrary: () =>
		importLocalLibManagerLibrary({
			context: input.context,
			state: input.state(),
			setPendingInstallPrompt: prompt => input.pendingInstallPrompt.set(prompt)
		}),
	removeLibrary: (packageName: string) =>
		removeLibManagerLibrary({
			context: input.context,
			packageName
		}),
	actionBusy: (action: 'install' | 'remove', packageName: string) =>
		input.actionBusyKey() === `${action}:${packageName}`,
	selectLibraryScope: (scope: LibManagerLibraryScope) =>
		selectLibManagerLibraryScope(nextScope => input.libraryScope.set(nextScope), scope),
	focusCoreLibraries: () =>
		focusLibManagerCoreLibraries(
			nextScope => input.libraryScope.set(nextScope),
			nextQuery => {
				input.libraryQuery.set(nextQuery)
				input.registrySearchResults.set([])
			}
		),
	scopeSelected: (scope: LibManagerLibraryScope) => isLibManagerScopeSelected(input.libraryScope(), scope),
	showDeclaredSection: () => shouldShowLibManagerDeclaredSection(input.libraryScope()),
	showMissingSection: () => shouldShowLibManagerMissingSection(input.libraryScope()),
	showCatalogSection: () => shouldShowLibManagerCatalogSection(input.libraryScope()),
	updateLibraryQuery: (event: Event) => {
		input.libraryQuery.set((event.target as HTMLInputElement).value)
		input.registrySearchResults.set([])
	},
	searchRegistryLibraries: () =>
		searchLibManagerRegistry({
			context: input.context,
			query: input.libraryQuery(),
			catalogNames: input.catalogLibraryViews().map(item => item.name)
		}),
	cancelInstallPrompt: () => input.pendingInstallPrompt.set(null),
	confirmInstallPrompt: () =>
		confirmLibManagerInstallPrompt({
			context: input.context,
			prompt: input.pendingInstallPrompt(),
			setPendingInstallPrompt: prompt => input.pendingInstallPrompt.set(prompt)
		}),
	loadLibraryVersions: (packageName: string) =>
		loadLibManagerVersions({
			context: input.context,
			packageName
		}),
	getLibraryVersions: (packageName: string) => input.libraryVersionsByPackage()[packageName] ?? null,
	resolveLiveActionProgressPercent: () => resolveLibManagerLiveActionProgressPercent(input.liveActionStatus()),
	resolveLiveActionLatestLine: () => resolveLibManagerLiveActionLatestLine(input.liveActionStatus())
})
