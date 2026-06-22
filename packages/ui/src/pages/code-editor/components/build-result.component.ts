import { Component, input } from '@angular/core'

import type { CodeEditorBuildResultView } from '../types'

/**
 * Code Editor 的构建结果面板。
 */
@Component({
	selector: 'code-editor-build-result',
	templateUrl: './build-result.component.html',
	styleUrl: './build-result.component.css'
})
export class CodeEditorBuildResultComponent {
	readonly buildResult = input<CodeEditorBuildResultView | null>(null)
}
