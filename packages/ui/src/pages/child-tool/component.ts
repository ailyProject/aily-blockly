import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { ActivatedRoute } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { getCore } from '@/utils/core'
import { getDesktop } from '@/utils/desktop'

import {
	acquireChildToolPageHost,
	loadChildTools,
	releaseChildToolPageHost,
	resolveChildToolPageState,
	restartChildToolPageHost
} from './runtime'

import type { ChildToolListItem, ChildToolPageState } from './types'

@Component({
	selector: 'child-tool-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ChildToolPageComponent implements OnInit {
	private readonly core = getCore()
	private readonly desktop = getDesktop()
	private readonly route = inject(ActivatedRoute)
	private readonly sanitizer = inject(DomSanitizer)

	protected readonly tools = signal<Array<ChildToolListItem>>([])
	protected readonly loading = signal(true)
	protected readonly error = signal<string | null>(null)
	protected readonly state = signal<ChildToolPageState>({
		tool: null,
		url: null,
		origin: null,
		frameUrl: null,
		hostInfo: null,
		usingHost: false
	})

	async ngOnInit() {
		await this.refresh(false)
	}

	async ngOnDestroy() {
		const toolId = this.state().tool?.id
		if (toolId) {
			await releaseChildToolPageHost(this.core, toolId)
		}
	}

	protected async restart() {
		await this.refresh(true)
	}

	private async refresh(forceRestart: boolean) {
		this.loading.set(true)
		this.error.set(null)

		const tools = await loadChildTools(this.core, this.desktop)
		this.tools.set(tools)

		const toolId = this.route.snapshot.paramMap.get('toolId')
		const rawUrl = this.route.snapshot.queryParamMap.get('url')

		try {
			const hostInfo = toolId
				? forceRestart
					? await restartChildToolPageHost(this.core, this.desktop, toolId)
					: await acquireChildToolPageHost(this.core, this.desktop, toolId)
				: null
			this.state.set({
				...resolveChildToolPageState(this.sanitizer, tools, toolId, rawUrl, hostInfo),
				usingHost: hostInfo !== null
			})
		} catch (error) {
			this.error.set((error as Error).message)
			this.state.set({
				...resolveChildToolPageState(this.sanitizer, tools, toolId, rawUrl, null),
				usingHost: false
			})
		} finally {
			this.loading.set(false)
		}
	}
}
