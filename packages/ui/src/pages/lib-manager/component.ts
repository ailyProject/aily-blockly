import { Component, OnInit } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import { AppShellComponent } from '@/layout/app-shell.component'
import { getCore } from '@/utils/core'
import { getDesktop, selectDesktopDirectory } from '@/utils/desktop'

import {
	LibManagerActivitySectionComponent,
	LibManagerCatalogSectionComponent,
	LibManagerDeclaredSectionComponent,
	LibManagerMissingSectionComponent,
	LibManagerRegistrySectionComponent
} from './components'
import { createLibManagerPageHandlers } from './utils/handlers'
import { createLibManagerActionContext } from './utils/runtime'
import { createLibManagerPageState } from './utils/state'

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
		refresh: () => this.handlers.refresh()
	})
	private readonly handlers = createLibManagerPageHandlers({
		core: this.core,
		state: this.state,
		loading: this.loading,
		error: this.error,
		npmRegistry: this.npmRegistry,
		libraryScope: this.libraryScope,
		libraryQuery: this.libraryQuery,
		actionBusyKey: this.actionBusyKey,
		pendingInstallPrompt: this.pendingInstallPrompt,
		registrySearchResults: this.registrySearchResults,
		libraryVersionsByPackage: this.libraryVersionsByPackage,
		catalogLibraryViews: this.catalogLibraryViews,
		liveActionStatus: this.liveActionStatus,
		context: this.actionContext
	})

	async ngOnInit() {
		await this.handlers.refresh()
	}
	protected readonly refresh = this.handlers.refresh
	protected readonly requestRestoreLibrary = this.handlers.requestRestoreLibrary
	protected readonly importLocalLibrary = this.handlers.importLocalLibrary
	protected readonly removeLibrary = this.handlers.removeLibrary
	protected readonly actionBusy = this.handlers.actionBusy
	protected readonly selectLibraryScope = this.handlers.selectLibraryScope
	protected readonly focusCoreLibraries = this.handlers.focusCoreLibraries
	protected readonly scopeSelected = this.handlers.scopeSelected
	protected readonly showDeclaredSection = this.handlers.showDeclaredSection
	protected readonly showMissingSection = this.handlers.showMissingSection
	protected readonly showCatalogSection = this.handlers.showCatalogSection
	protected readonly updateLibraryQuery = this.handlers.updateLibraryQuery
	protected readonly searchRegistryLibraries = this.handlers.searchRegistryLibraries
	protected readonly cancelInstallPrompt = this.handlers.cancelInstallPrompt
	protected readonly confirmInstallPrompt = this.handlers.confirmInstallPrompt
	protected readonly loadLibraryVersions = this.handlers.loadLibraryVersions
	protected readonly getLibraryVersions = this.handlers.getLibraryVersions
	protected readonly resolveLiveActionProgressPercent = this.handlers.resolveLiveActionProgressPercent
	protected readonly resolveLiveActionLatestLine = this.handlers.resolveLiveActionLatestLine
}
