import { Component, input, output } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import type { MissingBlocklyLibraryInfo } from 'shared'
import type { BlocklyEditorPageSummary } from '../types'

/**
 * Blockly Editor 的侧边检查面板。
 */
@Component({
	selector: 'blockly-editor-inspector-panel',
	imports: [FormsModule, HlmBadgeImports, HlmButtonImports, HlmCardImports, HlmInputImports],
	templateUrl: './inspector-panel.component.html',
	styleUrl: './inspector-panel.component.css'
})
export class BlocklyEditorInspectorPanelComponent {
	readonly categories = input.required<Array<{ name: string; count: number }>>()
	readonly activeWorkspaceSaveBusy = input(false)
	readonly activeWorkspaceDirty = input(false)
	readonly canSaveActiveWorkspace = input(false)
	readonly activeWorkspaceParseError = input<string | null>(null)
	readonly activeWorkspaceSaveMessage = input<string | null>(null)
	readonly projectReloadBusy = input(false)
	readonly projectReloadMessage = input<string | null>(null)
	readonly missingLibraries = input.required<Array<MissingBlocklyLibraryInfo>>()
	readonly missingLibraryActionBusyKey = input<string | null>(null)
	readonly missingLibraryActionMessage = input<string | null>(null)
	readonly activeWorkspaceJson = input('{}')
	readonly activeTopLevelBlockTypes = input.required<Array<string>>()
	readonly openedPages = input.required<Array<BlocklyEditorPageSummary>>()
	readonly closedPages = input.required<Array<BlocklyEditorPageSummary>>()
	readonly renamingPageId = input('')
	readonly renamingPageTitle = input('')
	readonly searchResultNames = input.required<Array<string>>()
	readonly resetActiveWorkspace = output<void>()
	readonly saveActiveWorkspace = output<void>()
	readonly activeWorkspaceJsonChange = output<string>()
	readonly switchPage = output<string>()
	readonly beginRenamePage = output<BlocklyEditorPageSummary>()
	readonly cancelRenamePage = output<void>()
	readonly renamingPageTitleChange = output<string>()
	readonly confirmRenamePage = output<BlocklyEditorPageSummary>()
	readonly togglePageOpen = output<{ pageId: string; opened: boolean }>()
	readonly reloadProjectState = output<void>()
	readonly restoreMissingLibrary = output<MissingBlocklyLibraryInfo>()
	readonly restoreAllMissingLibraries = output<void>()

	protected emitBeginRename(page: BlocklyEditorPageSummary, event: Event) {
		event.stopPropagation()
		this.beginRenamePage.emit(page)
	}

	protected emitCancelRename(event: Event) {
		event.stopPropagation()
		this.cancelRenamePage.emit()
	}

	protected emitConfirmRename(page: BlocklyEditorPageSummary, event: Event) {
		event.stopPropagation()
		this.confirmRenamePage.emit(page)
	}

	protected emitTogglePageOpen(pageId: string, opened: boolean, event: Event) {
		event.stopPropagation()
		this.togglePageOpen.emit({ pageId, opened })
	}

	protected isMissingLibraryBusy(packageName: string) {
		return this.missingLibraryActionBusyKey() === packageName
	}
}
