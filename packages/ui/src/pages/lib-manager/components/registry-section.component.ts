import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'

import type { LibManagerRegistryLibraryView, LibManagerVersionState } from '../types'

@Component({
	selector: 'lib-manager-registry-section',
	imports: [HlmBadgeImports, HlmButtonImports],
	templateUrl: './registry-section.component.html'
})
export class LibManagerRegistrySectionComponent {
	readonly libraries = input.required<Array<LibManagerRegistryLibraryView>>()
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
