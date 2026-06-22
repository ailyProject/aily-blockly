import type { CodeEditorSignals } from '../types'

/**
 * 聚合 Code Editor 页面使用的 signals 句柄。
 * @param input - 页面持有的各个 signal
 */
export const createCodeEditorSignals = (input: CodeEditorSignals): CodeEditorSignals => ({
	state: input.state,
	runtimeInfo: input.runtimeInfo,
	projectPath: input.projectPath,
	sourceCode: input.sourceCode,
	serialPort: input.serialPort,
	buildPlan: input.buildPlan,
	buildResult: input.buildResult,
	uploadPlan: input.uploadPlan,
	bleUploadPlan: input.bleUploadPlan,
	uploadResult: input.uploadResult,
	bleDevice: input.bleDevice,
	bleDevices: input.bleDevices,
	bleUploadProgress: input.bleUploadProgress,
	bleBridgeAvailable: input.bleBridgeAvailable,
	buildError: input.buildError,
	projectReloadMessage: input.projectReloadMessage,
	projectReloadBusy: input.projectReloadBusy,
	buildBusy: input.buildBusy,
	uploadBusy: input.uploadBusy
})
