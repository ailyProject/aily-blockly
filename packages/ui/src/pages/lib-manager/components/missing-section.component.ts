import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'

import type { MissingBlocklyLibraryInfo } from 'shared'
import type { LibManagerVersionState } from '../types'

@Component({
	selector: 'lib-manager-missing-section',
	imports: [HlmBadgeImports, HlmButtonImports],
	templateUrl: './missing-section.component.html'
})
export class LibManagerMissingSectionComponent {
	readonly libraries = input.required<Array<MissingBlocklyLibraryInfo>>()
	readonly actionBusyKey = input<string | null>(null)
	readonly versionLoadingPackage = input<string | null>(null)
	readonly libraryVersionsByPackage = input<Record<string, LibManagerVersionState>>({})

	readonly loadVersions = output<string>()
	readonly restore = output<{ packageName: string; version?: string; localPath?: string }>()

	protected actionBusy(packageName: string) {
		return this.actionBusyKey() === `install:${packageName}`
	}

	protected getLibraryVersions(packageName: string) {
		return this.libraryVersionsByPackage()[packageName] ?? null
	}
}
