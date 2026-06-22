import { Component, input, output } from '@angular/core'
import { HlmButtonImports } from 'spartan/button'

import type {
	CodeEditorBleDeviceListItem,
	CodeEditorBleDeviceView,
	CodeEditorBleUploadPlanView,
	CodeEditorBleUploadProgressView
} from '../types'

/**
 * Code Editor 的 BLE 上传面板。
 */
@Component({
	selector: 'code-editor-ble-panel',
	imports: [HlmButtonImports],
	templateUrl: './ble-panel.component.html',
	styleUrl: './ble-panel.component.css'
})
export class CodeEditorBlePanelComponent {
	readonly bleBridgeAvailable = input(false)
	readonly bleDevice = input<CodeEditorBleDeviceView | null>(null)
	readonly bleDevices = input.required<Array<CodeEditorBleDeviceListItem>>()
	readonly bleUploadPlan = input<CodeEditorBleUploadPlanView | null>(null)
	readonly bleUploadProgress = input<CodeEditorBleUploadProgressView | null>(null)
	readonly uploadBusy = input(false)
	readonly selectBleDevice = output<void>()
	readonly reconnectBleDevice = output<void>()
	readonly prepareBleUpload = output<void>()
	readonly runBleUpload = output<void>()
	readonly selectVisibleBleDevice = output<CodeEditorBleDeviceListItem>()
}
