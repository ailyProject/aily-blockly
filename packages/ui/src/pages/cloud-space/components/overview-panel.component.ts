import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import type { CloudProjectScope } from 'shared'
import type { CloudSpaceCurrentProjectBinding, CloudSpaceSyncSummary } from '../types'

@Component({
	selector: 'cloud-space-overview-panel',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports, HlmInputImports],
	templateUrl: './overview-panel.component.html',
	styleUrl: './overview-panel.component.css'
})
export class CloudSpaceOverviewPanelComponent {
	readonly scope = input.required<CloudProjectScope>()
	readonly totalItems = input(0)
	readonly query = input('')
	readonly board = input('')
	readonly authToken = input('')
	readonly rootPath = input('')
	readonly loading = input(false)
	readonly runtimeAvailable = input(false)
	readonly syncBusy = input(false)
	readonly hasOpenedProject = input(false)
	readonly page = input(1)
	readonly pageSize = input(20)
	readonly totalPages = input(1)
	readonly statusMessage = input<string | null>(null)
	readonly pendingTargetPath = input('')
	readonly targetPathConflict = input(false)
	readonly suggestedImportName = input('')
	readonly syncSummary = input<CloudSpaceSyncSummary | null>(null)
	readonly syncHistory = input<Array<CloudSpaceSyncSummary>>([])
	readonly currentProjectBinding = input<CloudSpaceCurrentProjectBinding | null>(null)

	readonly scopeChange = output<CloudProjectScope>()
	readonly queryChange = output<string>()
	readonly boardChange = output<string>()
	readonly authTokenChange = output<string>()
	readonly refresh = output<void>()
	readonly chooseRootPath = output<void>()
	readonly syncCurrentProject = output<void>()
	readonly pageSizeChange = output<number>()
	readonly previousPage = output<void>()
	readonly nextPage = output<void>()
	readonly importSuggestedName = output<void>()

	protected updateQuery(event: Event) {
		this.queryChange.emit((event.target as HTMLInputElement).value)
	}

	protected updateBoard(event: Event) {
		this.boardChange.emit((event.target as HTMLInputElement).value)
	}

	protected updateAuthToken(event: Event) {
		this.authTokenChange.emit((event.target as HTMLInputElement).value)
	}
}
