import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'

import type { LibManagerCatalogLibraryView, LibManagerVersionState } from '../types'

@Component({
	selector: 'lib-manager-catalog-section',
	imports: [HlmBadgeImports, HlmButtonImports],
	templateUrl: './catalog-section.component.html'
})
export class LibManagerCatalogSectionComponent {
	readonly libraries = input.required<Array<LibManagerCatalogLibraryView>>()
	readonly actionBusyKey = input<string | null>(null)
	readonly versionLoadingPackage = input<string | null>(null)
	readonly libraryVersionsByPackage = input<Record<string, LibManagerVersionState>>({})

	readonly loadVersions = output<string>()
	readonly install = output<{ packageName: string; version?: string }>()

	protected actionBusy(packageName: string) {
		return this.actionBusyKey() === `install:${packageName}`
	}

	protected getLibraryVersions(packageName: string) {
		return this.libraryVersionsByPackage()[packageName] ?? null
	}
}
