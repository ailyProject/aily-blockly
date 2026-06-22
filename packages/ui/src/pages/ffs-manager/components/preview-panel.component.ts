import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import type { FfsExplorerEntry, FfsManagerState } from '../types'

/**
 * FFS Manager 镜像预览面板。
 */
@Component({
	selector: 'ffs-manager-preview-panel',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './preview-panel.component.html',
	styleUrl: './preview-panel.component.css'
})
export class FfsManagerPreviewPanelComponent {
	readonly state = input<FfsManagerState | null>(null)
	readonly imageName = input<string | null>(null)
	readonly hasImageBytes = input(false)
	readonly previewBusy = input(false)
	readonly currentPath = input('/')
	readonly breadcrumbs = input.required<Array<{ name: string; path: string }>>()
	readonly explorerEntries = input.required<Array<FfsExplorerEntry>>()
	readonly imageInputClick = output<void>()
	readonly fileInputClick = output<void>()
	readonly formatImage = output<void>()
	readonly createDirectory = output<void>()
	readonly downloadImage = output<void>()
	readonly currentPathChange = output<string>()
	readonly previewEntry = output<FfsExplorerEntry>()
	readonly renameEntry = output<FfsExplorerEntry>()
	readonly deleteEntry = output<FfsExplorerEntry>()

	protected openEntry(entry: FfsExplorerEntry) {
		if (entry.type === 'dir') {
			this.currentPathChange.emit(entry.fullPath.replace(/\/$/, '') || '/')
		}
	}
}
