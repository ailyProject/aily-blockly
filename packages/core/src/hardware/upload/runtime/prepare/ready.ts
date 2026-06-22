import { resolveHardwareUploadArtifactPath } from '../../artifact'
import { resolveHardwareBleUploadPreparation } from '../../ble/preparation'
import { createHardwareUploadStep } from '../../plan'
import { prepareHardwareUploadPort } from '../../serialRuntime'
import { createPreparedUploadExecution } from './shared'

import type { ProjectBuildResult } from '../../../../build'
import type { HardwareRunUploadInput, HardwareUploadContext } from '../../types'

/**
 * 基于已存在的构建目录继续准备 BLE 上传分支。
 * @param input - 上传输入、构建上下文与构建结果
 */
export const prepareBleHardwareUploadExecution = (input: {
	runtimeInput: HardwareRunUploadInput
	context: HardwareUploadContext
	buildResult: ProjectBuildResult | null
}) => {
	const preparation = resolveHardwareBleUploadPreparation(input.context.buildPath)
	return createPreparedUploadExecution({
		status: 'ble-not-ready',
		ready: false,
		portType: input.runtimeInput.portType,
		buildPath: input.context.buildPath,
		builtBeforeUpload: Boolean(input.buildResult),
		artifactPath: preparation.firmwarePath,
		message: preparation.ready ? `${preparation.message}；BLE 传输宿主仍未迁移` : preparation.message,
		buildLogs: input.buildResult?.logs,
		buildStdout: input.buildResult?.stdout,
		buildStderr: input.buildResult?.stderr
	})
}

/**
 * 基于已存在的构建目录继续准备串口/调试器上传分支。
 * @param input - 上传输入、构建上下文与构建结果
 */
export const prepareReadyHardwareUploadExecution = async (input: {
	runtimeInput: HardwareRunUploadInput
	context: HardwareUploadContext
	buildResult: ProjectBuildResult | null
}) => {
	const finalPort =
		input.runtimeInput.portType === 'debugger'
			? ''
			: await prepareHardwareUploadPort({
					serialPort: input.runtimeInput.serialPort || '',
					use1200bpsTouch: input.runtimeInput.use1200bpsTouch,
					waitForUpload: input.runtimeInput.waitForUpload
				})
	const step = await createHardwareUploadStep({
		context: input.context,
		portType: input.runtimeInput.portType,
		serialPort: finalPort,
		pnum: input.runtimeInput.pnum,
		probeSerial: input.runtimeInput.probeSerial,
		probeVidPid: input.runtimeInput.probeVidPid
	})
	const artifactPath = resolveHardwareUploadArtifactPath(input.context.buildPath, step.args)

	return createPreparedUploadExecution({
		status: 'ready',
		ready: true,
		portType: input.runtimeInput.portType,
		buildPath: input.context.buildPath,
		builtBeforeUpload: Boolean(input.buildResult),
		port: finalPort || undefined,
		artifactPath: artifactPath || undefined,
		step,
		message: '上传执行已准备完成',
		buildLogs: input.buildResult?.logs,
		buildStdout: input.buildResult?.stdout,
		buildStderr: input.buildResult?.stderr
	})
}
