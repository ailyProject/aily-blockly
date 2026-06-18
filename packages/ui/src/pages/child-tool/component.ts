import { Component, inject, signal } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { ActivatedRoute } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { childTools } from '@/workspace'

import { resolveChildToolPageState } from './runtime'

import type { ChildToolPageState } from './types'

@Component({
	selector: 'child-tool-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ChildToolPageComponent {
	private readonly route = inject(ActivatedRoute)
	private readonly sanitizer = inject(DomSanitizer)

	protected readonly tools = childTools
	protected readonly state = signal<ChildToolPageState>(
		resolveChildToolPageState(
			this.sanitizer,
			this.route.snapshot.paramMap.get('toolId'),
			this.route.snapshot.queryParamMap.get('url')
		)
	)
}
