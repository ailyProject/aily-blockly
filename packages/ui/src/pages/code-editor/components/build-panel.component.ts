import { Component, computed, input, output } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import { CodeEditorBlePanelComponent } from './ble-panel.component'
import { CodeEditorBuildResultComponent } from './build-result.component'
import { CodeEditorUploadResultComponent } from './upload-result.component'

import type {
	CodeEditorBleDeviceListItem,
	CodeEditorBleDeviceView,
	CodeEditorBleUploadPlanView,
	CodeEditorBleUploadProgressView,
	CodeEditorBuildPlanSummary,
	CodeEditorBuildResultView,
	CodeEditorState,
	CodeEditorUploadPlanView,
	CodeEditorUploadResultView
} from '../types'

/**
 * Code Editor 的构建与上传卡片。
 */
@Component({
	selector: 'code-editor-build-panel',
	imports: [
		CodeEditorBlePanelComponent,
		CodeEditorBuildResultComponent,
		CodeEditorUploadResultComponent,
		FormsModule,
		HlmButtonImports,
		HlmCardImports,
		HlmInputImports
	],
	templateUrl: './build-panel.component.html',
	styleUrl: './build-panel.component.css'
})
export class CodeEditorBuildPanelComponent {
	readonly runtimeInfo = input<{ appDataPath: string; childPath?: string } | null>(null)
	readonly state = input<CodeEditorState | null>(null)
	readonly serialPort = input('')
	readonly sourceCode = input('')
	readonly buildPlan = input<CodeEditorBuildPlanSummary | null>(null)
	readonly buildResult = input<CodeEditorBuildResultView | null>(null)
	readonly uploadPlan = input<CodeEditorUploadPlanView | null>(null)
	readonly bleUploadPlan = input<CodeEditorBleUploadPlanView | null>(null)
	readonly uploadResult = input<CodeEditorUploadResultView | null>(null)
	readonly bleDevice = input<CodeEditorBleDeviceView | null>(null)
	readonly bleDevices = input.required<Array<CodeEditorBleDeviceListItem>>()
	readonly bleUploadProgress = input<CodeEditorBleUploadProgressView | null>(null)
	readonly bleBridgeAvailable = input(false)
	readonly buildError = input<string | null>(null)
	readonly buildBusy = input(false)
	readonly uploadBusy = input(false)
	readonly serialPortChange = output<string>()
	readonly sourceCodeChange = output<string>()
	readonly refreshPlan = output<void>()
	readonly runBuild = output<void>()
	readonly runUpload = output<void>()
	readonly selectBleDevice = output<void>()
	readonly reconnectBleDevice = output<void>()
	readonly prepareBleUpload = output<void>()
	readonly runBleUpload = output<void>()
	readonly selectVisibleBleDevice = output<CodeEditorBleDeviceListItem>()

	protected readonly buildMetrics = computed(() => [
		{ label: 'AppData', value: this.runtimeInfo()?.appDataPath || 'unavailable' },
		{ label: 'Child', value: this.runtimeInfo()?.childPath || 'unavailable' },
		{ label: 'Board', value: this.buildPlan()?.boardPackageName || 'unavailable' },
		{ label: 'Board Type', value: this.buildPlan()?.boardType || 'unavailable' },
		{ label: 'Libraries', value: String(this.buildPlan()?.libraryCount ?? 0) },
		{ label: 'Tool Versions', value: String(this.buildPlan()?.toolVersionCount ?? 0) },
		{ label: 'Macros', value: String(this.buildPlan()?.macroCount ?? 0) },
		{ label: 'Source Kind', value: this.state()?.sourceKind || 'manual' },
		{ label: 'Source File', value: this.state()?.sourceFilePath || 'editor buffer' }
	])

	protected updateSerialPort(event: Event) {
		this.serialPortChange.emit((event.target as HTMLInputElement).value)
	}
}
