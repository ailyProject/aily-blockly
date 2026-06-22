import { runTerminalBleUpload } from '../runtime'

import type { TerminalCurrentUploadActionInput } from './build.run.upload.types'

/**
 * 执行 terminal 的 BLE 上传动作。
 * @param input - upload 动作依赖
 * @param context - 当前运行时与项目上下文
 */
export const runTerminalBleUploadAction = async (
	input: TerminalCurrentUploadActionInput,
	context: {
		runtimeInfo: NonNullable<ReturnType<TerminalCurrentUploadActionInput['signals']['runtimeInfo']>>
		projectPath: string
		code: string
		target: NonNullable<ReturnType<TerminalCurrentUploadActionInput['signals']['uploadTargets']>>[number]
	}
) => {
	input.appendOutput('\n[upload live BLE session]\n')
	const bleResult = await runTerminalBleUpload({
		core: input.core,
		runtimeInfo: context.runtimeInfo,
		projectPath: context.projectPath,
		code: context.code,
		target: context.target,
		onProgress: progress => {
			const packetText =
				typeof progress.acknowledgedPackets === 'number' && typeof progress.totalPackets === 'number'
					? ` (${progress.acknowledgedPackets}/${progress.totalPackets})`
					: ''
			input.appendOutput(`[ble:${progress.phase}] ${progress.progress}% ${progress.text}${packetText}\n`)
		}
	})
	input.appendUploadSummary({
		success: bleResult.result.success,
		steps: [],
		progressEvents: bleResult.progressEvents.map(event => ({
			phase: event.phase,
			progress: event.progress
		})),
		stdout: bleResult.result.success ? bleResult.plan.message : '',
		error: bleResult.result.success ? undefined : bleResult.result.message,
		errorCode: bleResult.result.errorCode,
		artifactPath: bleResult.plan.artifactPath
	})
	input.appendOutput(`\n[upload ${bleResult.result.success ? 'done' : 'failed'}]\n`)
}
