import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { loadHomePageCoreState } from '@/pages/home/runtime'

import type { HomePageCoreState } from '@/pages/home/types'

@Component({
	selector: 'blockly-editor-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class BlocklyEditorPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly state = signal<HomePageCoreState | null>(null)

	async ngOnInit() {
		this.state.set(await loadHomePageCoreState(this.core))
	}
}
