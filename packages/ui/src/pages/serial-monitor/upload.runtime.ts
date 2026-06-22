import {
	renderUploadRecoveryHint,
	renderUploadStatusText,
	resolveUploadRecoveryActions,
	summarizeUploadResult
} from 'shared'

import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { SerialMonitorPageState, SerialMonitorUploadResultView } from './types'

/**
 * 通过当前串口监视器的连接配置执行串口上传。
 */
export const runSerialMonitorUpload = async (input: {
	core: Core
	runtimeInfo: DesktopHostRuntimeInfo
	state: SerialMonitorPageState
	projectPath: string
	code: string
}) => {
	const result = await input.core.hardware.runUpload.mutate({
		projectPath: input.projectPath,
		appDataPath: input.runtimeInfo.appDataPath,
		childPath: input.runtimeInfo.childPath ?? '',
		code: input.code,
		portType: 'serial',
		serialPort: input.state.connectOptions.path,
		rebuildBeforeUpload: true
	})
	const summary = result.summary ?? summarizeUploadResult(result)

	return {
		channel: summary.channel,
		status: summary.status,
		errorCode: summary.errorCode,
		message: summary.message,
		statusText: renderUploadStatusText(summary.status, summary.errorCode),
		recoveryHint: renderUploadRecoveryHint(summary.errorCode),
		recoveryActions: resolveUploadRecoveryActions(summary),
		success: result.success,
		durationMs: result.durationMs,
		port: result.port,
		artifactPath: result.artifactPath,
		latestPhaseText: summary.latestPhaseText,
		logs: result.logs,
		error: summary.status === 'success' ? undefined : summary.message
	} satisfies SerialMonitorUploadResultView
}
