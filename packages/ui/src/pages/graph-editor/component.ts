import { Component, inject, OnInit, signal } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { ActivatedRoute } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { boardIndex } from '@/workspace'

import { loadGraphEditorPaths, resolveGraphEditorState } from './runtime'

@Component({
	selector: 'graph-editor-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class GraphEditorPageComponent implements OnInit {
	private readonly core = injectCore()
	private readonly route = inject(ActivatedRoute)
	private readonly sanitizer = inject(DomSanitizer)

	protected readonly boards = boardIndex
	protected readonly state = signal(
		resolveGraphEditorState(this.sanitizer, this.route.snapshot.queryParamMap.get('url'))
	)

	async ngOnInit() {
		const paths = await loadGraphEditorPaths(this.core)
		this.state.update(current => ({ ...current, ...paths }))
	}
}
