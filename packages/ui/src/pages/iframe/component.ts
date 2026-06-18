import { Component, inject, signal } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { ActivatedRoute } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { embedTargets } from '@/workspace'

import { resolveIframePageState } from './runtime'

import type { IframePageState } from './types'

@Component({
	selector: 'iframe-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class IframePageComponent {
	private readonly route = inject(ActivatedRoute)
	private readonly sanitizer = inject(DomSanitizer)

	protected readonly targets = embedTargets
	protected readonly state = signal<IframePageState>(
		resolveIframePageState(
			this.sanitizer,
			this.route.snapshot.queryParamMap.get('url'),
			this.route.snapshot.queryParamMap.get('title')
		)
	)
}
