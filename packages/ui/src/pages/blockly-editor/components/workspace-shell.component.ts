import { Component, input, output } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import type { BlocklyEditorActiveViewState, BlocklyEditorPageSummary } from '../types'

/**
 * Blockly Editor 的工作区壳组件。
 */
@Component({
	selector: 'blockly-editor-workspace-shell',
	imports: [FormsModule, HlmBadgeImports, HlmButtonImports, HlmCardImports, HlmInputImports],
	templateUrl: './workspace-shell.component.html',
	styleUrl: './workspace-shell.component.css'
})
export class BlocklyEditorWorkspaceShellComponent {
	readonly language = input('')
	readonly searchQuery = input('')
	readonly projectPath = input('')
	readonly abiExists = input(false)
	readonly toolbarCount = input(0)
	readonly visibleToolbarCount = input(0)
	readonly boardValidation = input('')
	readonly libraryValidation = input('')
	readonly abiSchemaVersion = input<number | undefined>(undefined)
	readonly pageCount = input(0)
	readonly totalBlockCount = input(0)
	readonly sharedVariableCount = input(0)
	readonly sharedProcedureCount = input(0)
	readonly activePageId = input('')
	readonly openedPageCount = input(0)
	readonly activePageTitle = input('')
	readonly activeViewState = input<BlocklyEditorActiveViewState | null>(null)
	readonly activeTopLevelBlockCount = input(0)
	readonly abiFilePath = input('')
	readonly abiParseError = input<string | undefined>(undefined)
	readonly activeViewScaleDraft = input('1')
	readonly activeViewScrollXDraft = input('0')
	readonly activeViewScrollYDraft = input('0')
	readonly canSaveActiveViewState = input(false)
	readonly openedPages = input.required<Array<BlocklyEditorPageSummary>>()
	readonly workspaceHints = input.required<Array<string>>()
	readonly searchQueryChange = output<string>()
	readonly viewStateDraftChange = output<{ field: 'scale' | 'scrollX' | 'scrollY'; value: string }>()
	readonly saveViewState = output<void>()
	readonly switchPage = output<string>()
	readonly createPage = output<void>()

	protected updateSearchQuery(event: Event) {
		this.searchQueryChange.emit((event.target as HTMLInputElement).value)
	}

	protected updateViewStateDraft(field: 'scale' | 'scrollX' | 'scrollY', value: string) {
		this.viewStateDraftChange.emit({ field, value })
	}
}
