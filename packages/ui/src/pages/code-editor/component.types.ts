import type { WritableSignal } from '@angular/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
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
} from './types'

export type CodeEditorSignals = {
	state: WritableSignal<CodeEditorState | null>
	runtimeInfo: WritableSignal<DesktopHostRuntimeInfo | null>
	projectPath: WritableSignal<string>
	sourceCode: WritableSignal<string>
	serialPort: WritableSignal<string>
	buildPlan: WritableSignal<CodeEditorBuildPlanSummary | null>
	buildResult: WritableSignal<CodeEditorBuildResultView | null>
	uploadPlan: WritableSignal<CodeEditorUploadPlanView | null>
	bleUploadPlan: WritableSignal<CodeEditorBleUploadPlanView | null>
	uploadResult: WritableSignal<CodeEditorUploadResultView | null>
	bleDevice: WritableSignal<CodeEditorBleDeviceView | null>
	bleDevices: WritableSignal<Array<CodeEditorBleDeviceListItem>>
	bleUploadProgress: WritableSignal<CodeEditorBleUploadProgressView | null>
	bleBridgeAvailable: WritableSignal<boolean>
	buildError: WritableSignal<string | null>
	projectReloadMessage: WritableSignal<string | null>
	projectReloadBusy: WritableSignal<boolean>
	buildBusy: WritableSignal<boolean>
	uploadBusy: WritableSignal<boolean>
}
