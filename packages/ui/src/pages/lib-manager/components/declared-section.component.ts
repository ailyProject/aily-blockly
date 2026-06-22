import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'

import type { LibManagerDeclaredLibraryView, LibManagerVersionState } from '../types'

@Component({
	selector: 'lib-manager-declared-section',
	imports: [HlmBadgeImports, HlmButtonImports],
	templateUrl: './declared-section.component.html'
})
export class LibManagerDeclaredSectionComponent {
	readonly libraries = input.required<Array<LibManagerDeclaredLibraryView>>()
	readonly actionBusyKey = input<string | null>(null)
	readonly versionLoadingPackage = input<string | null>(null)
	readonly libraryVersionsByPackage = input<Record<string, LibManagerVersionState>>({})

	readonly loadVersions = output<string>()
	readonly restore = output<{ packageName: string; version?: string; localPath?: string }>()
	readonly remove = output<string>()

	protected actionBusy(action: 'install' | 'remove', packageName: string) {
		return this.actionBusyKey() === `${action}:${packageName}`
	}

	protected getLibraryVersions(packageName: string) {
		return this.libraryVersionsByPackage()[packageName] ?? null
	}
}
