import { executeBleOtaUpload } from '@/runtime/ble-upload'

import {
	createCodeEditorBleUploadCompletedResult,
	createCodeEditorBleUploadNotReadyResult,
	createCodeEditorBleUploadRuntimeFailureResult
} from './result'

import type {
	CodeEditorBleUploadPlanView,
	CodeEditorBleUploadProgressView,
	CodeEditorUploadResultView
} from '../../types'

/**
 * 执行 BLE OTA 上传。
 * @param plan - 上传计划
 * @param deviceId - 当前 BLE 设备 ID
 * @param onProgress - 进度回调
 */
export const runCodeEditorBleUpload = async (
	plan: CodeEditorBleUploadPlanView,
	deviceId: string,
	onProgress?: (progress: CodeEditorBleUploadProgressView) => void
): Promise<CodeEditorUploadResultView> => {
	const startedAt = Date.now()
	let lastPhase: CodeEditorBleUploadProgressView['phase'] | null = null
	let lastPercent: number | undefined
	let lastAckCount: number | undefined
	const handleProgress = (progress: CodeEditorBleUploadProgressView) => {
		lastPhase = progress.phase
		lastPercent = progress.progress
		lastAckCount = progress.acknowledgedPackets
		onProgress?.(progress)
	}

	if (!plan.ready || !plan.startCommandBase64 || !plan.stopCommandBase64) {
		return createCodeEditorBleUploadNotReadyResult(plan)
	}

	try {
		const result = await executeBleOtaUpload({
			deviceId,
			startCommandBase64: plan.startCommandBase64,
			stopCommandBase64: plan.stopCommandBase64,
			packets: plan.packets,
			onProgress: handleProgress
		})
		return createCodeEditorBleUploadCompletedResult({
			plan,
			result,
			startedAt
		})
	} catch {
		return createCodeEditorBleUploadRuntimeFailureResult({
			plan,
			startedAt,
			lastAckCount,
			lastPhase,
			lastPercent
		})
	}
}
