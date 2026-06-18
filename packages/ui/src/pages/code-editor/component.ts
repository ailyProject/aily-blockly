import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'

import { loadCodeEditorState } from './runtime'

export interface CodeEditorStateView {
	lintMode: string
	errorCount: number
	warningCount: number
	executionTime: number
	parsedBlockCount: number
	stringifiedLength: number
}

@Component({
	selector: 'code-editor-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class CodeEditorPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly state = signal<CodeEditorStateView | null>(null)
	protected readonly compileSummary = signal('')

	async ngOnInit() {
		this.state.set(await loadCodeEditorState(this.core))
		this.compileSummary.set('Build diagnostics stream will be wired here after editor migration.')
	}
}
