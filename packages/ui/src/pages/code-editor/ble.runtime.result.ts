import {
	renderUploadRecoveryHint,
	renderUploadStatusText,
	resolveUploadRecoveryActions,
	summarizeUploadResult
} from 'shared'

import type { CodeEditorBleUploadPlanView, CodeEditorUploadResultView } from './types'

/**
 * 把 BLE 上传摘要规整为 Code Editor 展示结果。
 * @param input - 统一摘要输入
 */
export const createCodeEditorBleUploadResult = (input: {
	success: boolean
	durationMs: number
	artifactPath?: string
	progressEventCount: number
	latestProgressText?: string
	stdout: string
	stderr: string
	error?: string
	errorCode?: import('shared').UploadErrorCode
}) => {
	const summary = summarizeUploadResult({
		success: input.success,
		stdout: input.stdout,
		error: input.error,
		errorCode: input.errorCode,
		artifactPath: input.artifactPath,
		progressEvents: input.latestProgressText ? [{ phase: input.latestProgressText }] : [],
		steps: []
	})

	return {
		channel: summary.channel,
		status: summary.status,
		errorCode: summary.errorCode,
		message: summary.message,
		statusText: renderUploadStatusText(summary.status, summary.errorCode),
		recoveryHint: renderUploadRecoveryHint(summary.errorCode),
		recoveryActions: resolveUploadRecoveryActions(summary),
		success: input.success,
		durationMs: input.durationMs,
		artifactPath: input.artifactPath,
		progressEventCount: input.progressEventCount,
		latestProgressText: input.latestProgressText ?? summary.latestPhaseText,
		stdout: input.stdout,
		stderr: input.stderr,
		logs: [],
		error: summary.status === 'success' ? undefined : summary.message
	} satisfies CodeEditorUploadResultView
}

/**
 * 构造 BLE 上传未准备就绪的展示结果。
 * @param plan - 当前 BLE 上传计划
 */
export const createCodeEditorBleUploadNotReadyResult = (plan: CodeEditorBleUploadPlanView) =>
	createCodeEditorBleUploadResult({
		success: false,
		durationMs: 0,
		artifactPath: plan.artifactPath,
		progressEventCount: 0,
		latestProgressText: 'not-ready',
		stdout: '',
		stderr: '',
		error: plan.message
	})

/**
 * 构造 BLE 上传执行完成后的展示结果。
 * @param input - 执行结果上下文
 */
export const createCodeEditorBleUploadCompletedResult = (input: {
	plan: CodeEditorBleUploadPlanView
	result: {
		success: boolean
		message?: string
		errorCode?: import('shared').UploadErrorCode
		progressEventCount: number
		latestProgressText?: string
	}
	startedAt: number
}) =>
	createCodeEditorBleUploadResult({
		success: input.result.success,
		durationMs: Date.now() - input.startedAt,
		artifactPath: input.plan.artifactPath,
		progressEventCount: input.result.progressEventCount,
		latestProgressText: input.result.latestProgressText,
		stdout: input.result.success ? input.plan.message : '',
		stderr: '',
		error: input.result.success ? undefined : input.result.message || 'BLE upload failed',
		errorCode: input.result.errorCode
	})

/**
 * 构造 BLE 上传运行时异常结果。
 * @param input - 运行时异常上下文
 */
export const createCodeEditorBleUploadRuntimeFailureResult = (input: {
	plan: CodeEditorBleUploadPlanView
	startedAt: number
	lastAckCount?: number
	lastPhase?: string | null
	lastPercent?: number
}) =>
	createCodeEditorBleUploadResult({
		success: false,
		durationMs: Date.now() - input.startedAt,
		artifactPath: input.plan.artifactPath,
		progressEventCount: input.lastAckCount ?? 0,
		latestProgressText: input.lastPhase || 'error',
		stdout: '',
		stderr: '',
		error: 'BLE upload runtime failed unexpectedly',
		errorCode: 'unknown'
	})
