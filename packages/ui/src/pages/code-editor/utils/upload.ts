import {
	renderUploadRecoveryHint,
	renderUploadStatusText,
	resolveUploadRecoveryActions,
	summarizeUploadResult
} from 'shared'

import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { CodeEditorUploadPlanView, CodeEditorUploadResultView } from '../types'

/**
 * 预览当前项目上传步骤。
 */
export const loadCodeEditorUploadPlan = async (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo,
	projectPath: string,
	serialPort: string
): Promise<CodeEditorUploadPlanView> => {
	const step = await core.hardware.planUpload.query({
		projectPath,
		appDataPath: runtimeInfo.appDataPath,
		childPath: runtimeInfo.childPath ?? '',
		portType: 'serial',
		serialPort
	})

	return {
		label: step.label,
		commandPreview: [step.command, ...step.args].join(' ')
	}
}

/**
 * 执行当前项目上传。
 */
export const runCodeEditorUpload = async (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo,
	projectPath: string,
	code: string,
	serialPort: string,
	portType: 'serial' | 'ble' = 'serial'
): Promise<CodeEditorUploadResultView> => {
	const result = await core.hardware.runUpload.mutate({
		projectPath,
		appDataPath: runtimeInfo.appDataPath,
		childPath: runtimeInfo.childPath ?? '',
		code,
		portType,
		serialPort,
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
		progressEventCount: result.progressEvents.length,
		latestProgressText: summary.latestPhaseText,
		stdout: result.stdout,
		stderr: result.stderr,
		logs: result.logs,
		error: summary.status === 'success' ? undefined : summary.message
	}
}
