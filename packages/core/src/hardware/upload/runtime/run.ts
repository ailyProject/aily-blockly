import { currentUploadCancelled, runHardwareUploadStep } from './execute'
import { createCancelledUploadResult, createCompletedUploadResult } from './results'

import type { HardwarePreparedUploadExecution } from '../types'

/**
 * 在上传准备成功后执行真实上传步骤。
 * @param startedAt - 上传链路开始时间
 * @param prepared - 已准备好的上传执行结果
 */
export const runPreparedHardwareUpload = async (
	startedAt: number,
	prepared: HardwarePreparedUploadExecution & {
		ready: true
		step: NonNullable<HardwarePreparedUploadExecution['step']>
	}
) => {
	const output = await runHardwareUploadStep(prepared.step)
	if (currentUploadCancelled) {
		return createCancelledUploadResult({
			startedAt,
			artifactPath: prepared.artifactPath,
			port: prepared.port,
			buildPath: prepared.buildPath,
			builtBeforeUpload: prepared.builtBeforeUpload,
			step: prepared.step,
			stdout: output.stdout,
			stderr: output.stderr,
			progressEvents: output.progressEvents,
			buildStdout: prepared.buildStdout,
			buildStderr: prepared.buildStderr,
			buildLogs: prepared.buildLogs
		})
	}

	const success = output.exitCode === 0
	return createCompletedUploadResult({
		startedAt,
		success,
		artifactPath: prepared.artifactPath,
		port: prepared.port,
		buildPath: prepared.buildPath,
		builtBeforeUpload: prepared.builtBeforeUpload,
		step: prepared.step,
		stdout: output.stdout,
		stderr: output.stderr,
		progressEvents: output.progressEvents,
		buildStdout: prepared.buildStdout,
		buildStderr: prepared.buildStderr,
		buildLogs: prepared.buildLogs,
		exitCode: output.exitCode
	})
}
