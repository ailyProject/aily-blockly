import { Component, inject, OnInit, signal } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { ActivatedRoute } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'

import { loadChildTools, resolveChildToolPageState } from './runtime'

import type { ChildToolListItem, ChildToolPageState } from './types'

@Component({
	selector: 'child-tool-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ChildToolPageComponent implements OnInit {
	private readonly core = injectCore()
	private readonly route = inject(ActivatedRoute)
	private readonly sanitizer = inject(DomSanitizer)

	protected readonly tools = signal<Array<ChildToolListItem>>([])
	protected readonly state = signal<ChildToolPageState>({
		tool: null,
		url: null,
		origin: null,
		frameUrl: null
	})

	async ngOnInit() {
		const tools = await loadChildTools(this.core)
		this.tools.set(tools)
		this.state.set(
			resolveChildToolPageState(
				this.sanitizer,
				tools,
				this.route.snapshot.paramMap.get('toolId'),
				this.route.snapshot.queryParamMap.get('url')
			)
		)
	}
}
