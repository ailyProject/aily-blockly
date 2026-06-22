import {
	createBleNotReadyUploadResult,
	createBuildFailedUploadResult,
	createMissingArtifactUploadResult,
	createMissingPortUploadResult
} from './results'

import type { HardwarePreparedUploadExecution, HardwareRunUploadResult } from '../types'

/**
 * 把上传准备阶段的失败状态转换为最终上传结果。
 * @param startedAt - 上传链路开始时间
 * @param prepared - 上传准备结果
 */
export const createPreflightUploadResult = (
	startedAt: number,
	prepared: HardwarePreparedUploadExecution
): HardwareRunUploadResult | null => {
	if (prepared.status === 'missing-port') {
		return createMissingPortUploadResult(startedAt)
	}
	if (prepared.status === 'build-failed') {
		return createBuildFailedUploadResult(startedAt, {
			logs: prepared.buildLogs,
			stdout: prepared.buildStdout,
			stderr: prepared.buildStderr,
			errorText: prepared.message
		})
	}
	if (prepared.status === 'missing-artifact') {
		return createMissingArtifactUploadResult({
			startedAt,
			buildPath: prepared.buildPath,
			builtBeforeUpload: prepared.builtBeforeUpload,
			buildStdout: prepared.buildStdout,
			buildStderr: prepared.buildStderr,
			buildLogs: prepared.buildLogs
		})
	}
	if (prepared.status === 'ble-not-ready') {
		return createBleNotReadyUploadResult({
			startedAt,
			firmwarePath: prepared.artifactPath,
			buildPath: prepared.buildPath,
			message: prepared.message,
			ready: false,
			builtBeforeUpload: prepared.builtBeforeUpload,
			buildStdout: prepared.buildStdout,
			buildStderr: prepared.buildStderr,
			buildLogs: prepared.buildLogs
		})
	}
	if (!prepared.ready || !prepared.step) {
		return createMissingArtifactUploadResult({
			startedAt,
			buildPath: prepared.buildPath,
			builtBeforeUpload: prepared.builtBeforeUpload,
			buildStdout: prepared.buildStdout,
			buildStderr: prepared.buildStderr,
			buildLogs: prepared.buildLogs
		})
	}

	return null
}
