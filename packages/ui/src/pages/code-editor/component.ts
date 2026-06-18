import { Component, OnInit, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'

import { sampleLintOutput } from './data'

@Component({
	selector: 'code-editor-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class CodeEditorPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly lintResult = signal<Awaited<
		ReturnType<typeof this.core.build.parseArduinoLintResult.query>
	> | null>(null)

	async ngOnInit() {
		this.lintResult.set(
			await this.core.build.parseArduinoLintResult.query({
				output: sampleLintOutput,
				startTime: Date.now() - 32,
				mode: 'fast',
				format: 'vscode'
			})
		)
	}
}
