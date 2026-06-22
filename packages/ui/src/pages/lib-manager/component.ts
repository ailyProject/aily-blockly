import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import { AppShellComponent } from '@/layout/app-shell.component'
import { getCore } from '@/utils/core'
import { getDesktop, selectDesktopDirectory } from '@/utils/desktop'

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
} from './component.interactions'
import {
	createLibManagerActionContext,
	isLibManagerScopeSelected,
	resolveLibManagerLiveActionLatestLine,
	resolveLibManagerLiveActionProgressPercent,
	shouldShowLibManagerCatalogSection,
	shouldShowLibManagerDeclaredSection,
	shouldShowLibManagerMissingSection
} from './component.runtime'
import { createLibManagerPageState } from './component.state'
import {
	LibManagerActivitySectionComponent,
	LibManagerCatalogSectionComponent,
	LibManagerDeclaredSectionComponent,
	LibManagerMissingSectionComponent,
	LibManagerRegistrySectionComponent
} from './components'

import type { LibManagerActionContext, LibManagerLibraryScope } from './types'

@Component({
	selector: 'lib-manager-page',
	imports: [
		AppShellComponent,
		HlmBadgeImports,
		HlmButtonImports,
		HlmCardImports,
		HlmInputImports,
		LibManagerActivitySectionComponent,
		LibManagerCatalogSectionComponent,
		LibManagerDeclaredSectionComponent,
		LibManagerMissingSectionComponent,
		LibManagerRegistrySectionComponent
	],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class LibManagerPageComponent implements OnInit {
	private readonly core = getCore()
	private readonly desktop = getDesktop()
	private readonly pageState = createLibManagerPageState()
	protected readonly state = this.pageState.state
	protected readonly loading = this.pageState.loading
	protected readonly error = this.pageState.error
	protected readonly actionBusyKey = this.pageState.actionBusyKey
	protected readonly statusMessage = this.pageState.statusMessage
	protected readonly npmRegistry = this.pageState.npmRegistry
	protected readonly registrySearchBusy = this.pageState.registrySearchBusy
	protected readonly registrySearchResults = this.pageState.registrySearchResults
	protected readonly lastActionOutput = this.pageState.lastActionOutput
	protected readonly liveActionStatus = this.pageState.liveActionStatus
	protected readonly versionLoadingPackage = this.pageState.versionLoadingPackage
	protected readonly libraryVersionsByPackage = this.pageState.libraryVersionsByPackage
	protected readonly libraryQuery = this.pageState.libraryQuery
	protected readonly libraryScope = this.pageState.libraryScope
	protected readonly pendingInstallPrompt = this.pageState.pendingInstallPrompt
	protected readonly declaredLibraryViews = this.pageState.declaredLibraryViews
	protected readonly filteredDeclaredLibraryViews = this.pageState.filteredDeclaredLibraryViews
	protected readonly filteredMissingLibraries = this.pageState.filteredMissingLibraries
	protected readonly catalogLibraryViews = this.pageState.catalogLibraryViews
	private readonly actionContext: LibManagerActionContext = createLibManagerActionContext({
		core: this.core,
		desktop: this.desktop,
		selectDesktopDirectory,
		state: this.state,
		actionBusyKey: this.actionBusyKey,
		statusMessage: this.statusMessage,
		lastActionOutput: this.lastActionOutput,
		liveActionStatus: this.liveActionStatus,
		pendingInstallPrompt: this.pendingInstallPrompt,
		registrySearchBusy: this.registrySearchBusy,
		registrySearchResults: this.registrySearchResults,
		versionLoadingPackage: this.versionLoadingPackage,
		libraryVersionsByPackage: this.libraryVersionsByPackage,
		npmRegistry: this.npmRegistry,
		refresh: () => this.refresh()
	})

	async ngOnInit() {
		await this.refresh()
	}

	protected readonly refresh = () =>
		refreshLibManagerPage({
			core: this.core,
			setLoading: loading => this.loading.set(loading),
			setError: message => this.error.set(message),
			clearPendingInstallPrompt: () => this.pendingInstallPrompt.set(null),
			setState: state => this.state.set(state),
			setNpmRegistry: registry => this.npmRegistry.set(registry)
		})

	protected readonly requestRestoreLibrary = (packageName: string, version?: string, localPath?: string) =>
		requestLibManagerRestore({
			context: this.actionContext,
			state: this.state(),
			setPendingInstallPrompt: prompt => this.pendingInstallPrompt.set(prompt),
			packageName,
			version,
			localPath
		})

	protected readonly importLocalLibrary = () =>
		importLocalLibManagerLibrary({
			context: this.actionContext,
			state: this.state(),
			setPendingInstallPrompt: prompt => this.pendingInstallPrompt.set(prompt)
		})

	protected readonly removeLibrary = (packageName: string) =>
		removeLibManagerLibrary({
			context: this.actionContext,
			packageName
		})

	protected actionBusy(action: 'install' | 'remove', packageName: string) {
		return this.actionBusyKey() === `${action}:${packageName}`
	}

	protected readonly selectLibraryScope = (scope: LibManagerLibraryScope) =>
		selectLibManagerLibraryScope(nextScope => this.libraryScope.set(nextScope), scope)

	protected readonly focusCoreLibraries = () =>
		focusLibManagerCoreLibraries(
			nextScope => this.libraryScope.set(nextScope),
			nextQuery => {
				this.libraryQuery.set(nextQuery)
				this.registrySearchResults.set([])
			}
		)

	protected readonly scopeSelected = (scope: LibManagerLibraryScope) =>
		isLibManagerScopeSelected(this.libraryScope(), scope)
	protected readonly showDeclaredSection = () => shouldShowLibManagerDeclaredSection(this.libraryScope())
	protected readonly showMissingSection = () => shouldShowLibManagerMissingSection(this.libraryScope())
	protected readonly showCatalogSection = () => shouldShowLibManagerCatalogSection(this.libraryScope())

	protected updateLibraryQuery(event: Event) {
		this.libraryQuery.set((event.target as HTMLInputElement).value)
		this.registrySearchResults.set([])
	}

	protected readonly searchRegistryLibraries = () =>
		searchLibManagerRegistry({
			context: this.actionContext,
			query: this.libraryQuery(),
			catalogNames: this.catalogLibraryViews().map(item => item.name)
		})

	protected readonly cancelInstallPrompt = () => this.pendingInstallPrompt.set(null)

	protected readonly confirmInstallPrompt = () =>
		confirmLibManagerInstallPrompt({
			context: this.actionContext,
			prompt: this.pendingInstallPrompt(),
			setPendingInstallPrompt: prompt => this.pendingInstallPrompt.set(prompt)
		})

	protected readonly loadLibraryVersions = (packageName: string) =>
		loadLibManagerVersions({
			context: this.actionContext,
			packageName
		})

	protected getLibraryVersions(packageName: string) {
		return this.libraryVersionsByPackage()[packageName] ?? null
	}

	protected readonly resolveLiveActionProgressPercent = () =>
		resolveLibManagerLiveActionProgressPercent(this.liveActionStatus())
	protected readonly resolveLiveActionLatestLine = () => resolveLibManagerLiveActionLatestLine(this.liveActionStatus())
}
