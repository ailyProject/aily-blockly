import { Component, input, output } from '@angular/core'
import { HlmButtonImports } from 'spartan/button'

import type { CodeEditorBleDeviceView, CodeEditorBleUploadPlanView, CodeEditorUploadResultView } from '../types'

/**
 * Code Editor 的上传结果面板。
 */
@Component({
	selector: 'code-editor-upload-result',
	imports: [HlmButtonImports],
	templateUrl: './upload-result.component.html',
	styleUrl: './upload-result.component.css'
})
export class CodeEditorUploadResultComponent {
	readonly uploadResult = input<CodeEditorUploadResultView | null>(null)
	readonly buildBusy = input(false)
	readonly uploadBusy = input(false)
	readonly bleUploadPlan = input<CodeEditorBleUploadPlanView | null>(null)
	readonly bleDevice = input<CodeEditorBleDeviceView | null>(null)
	readonly runBuild = output<void>()
	readonly runUpload = output<void>()
	readonly reconnectBleDevice = output<void>()
	readonly prepareBleUpload = output<void>()
	readonly runBleUpload = output<void>()
}
