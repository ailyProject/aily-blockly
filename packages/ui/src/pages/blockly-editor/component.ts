import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import { injectCore } from '@/core-service'

import { blocklyEditorWorkspaceHints } from './data'
import { loadBlocklyEditorState, searchBlocklyEditorCatalog } from './runtime'

@Component({
	selector: 'blockly-editor-page',
	imports: [HlmBadgeImports, HlmCardImports, HlmInputImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class BlocklyEditorPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly workspaceHints = blocklyEditorWorkspaceHints
	protected readonly categories = signal<Array<{ name: string; count: number }>>([])
	protected readonly boardValidation = signal('pending')
	protected readonly libraryValidation = signal('pending')
	protected readonly toolbarCount = signal(0)
	protected readonly visibleToolbarCount = signal(0)
	protected readonly language = signal('unknown')
	protected readonly searchQuery = signal('esp32')
	protected readonly searchResultNames = signal<Array<string>>([])

	async ngOnInit() {
		const state = await loadBlocklyEditorState(this.core)
		this.categories.set(state.categories)
		this.boardValidation.set(state.boardValidation)
		this.libraryValidation.set(state.libraryValidation)
		this.toolbarCount.set(state.toolbarCount)
		this.visibleToolbarCount.set(state.visibleToolbarCount)
		this.language.set(state.language)
		this.searchResultNames.set(state.searchResultNames)
	}

	protected async updateSearchQuery(event: Event) {
		const nextQuery = (event.target as HTMLInputElement).value
		this.searchQuery.set(nextQuery)
		this.searchResultNames.set(await searchBlocklyEditorCatalog(this.core, nextQuery || 'esp32'))
	}
}
