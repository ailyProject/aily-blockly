import { executeBleOtaUpload, probeBleOtaPacketSize } from '@/runtime/ble-upload'

import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { TerminalUploadTargetOption } from '../types'

/**
 * 为 terminal 页面准备 BLE OTA 上传计划。
 * @param core - core 服务句柄
 * @param runtimeInfo - desktop 运行时信息
 * @param projectPath - 当前项目目录
 * @param code - 当前源码
 * @param deviceId - 已授权 BLE 设备 ID
 */
export const planTerminalBleUpload = async (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo,
	projectPath: string,
	code: string | undefined,
	deviceId: string
) => {
	const packetSize = await probeBleOtaPacketSize(deviceId).catch(() => undefined)

	return core.hardware.prepareBleUpload.mutate({
		projectPath,
		appDataPath: runtimeInfo.appDataPath,
		childPath: runtimeInfo.childPath ?? '',
		code: code?.trim() ? code : undefined,
		rebuildBeforeUpload: true,
		packetSize
	})
}

/**
 * 在 terminal 页面执行 BLE OTA 上传。
 * @param input - core、运行时、项目与目标上下文
 */
export const runTerminalBleUpload = async (input: {
	core: Core
	runtimeInfo: DesktopHostRuntimeInfo
	projectPath: string
	code?: string
	target: TerminalUploadTargetOption
	onProgress?: (progress: {
		phase: 'starting' | 'sending' | 'stopping' | 'done' | 'error'
		progress: number
		text: string
		acknowledgedPackets?: number
		totalPackets?: number
	}) => void
}) => {
	if (!input.target.deviceId) {
		throw new Error('BLE upload target is missing deviceId.')
	}

	const progressEvents: Array<{
		phase: 'starting' | 'sending' | 'stopping' | 'done' | 'error'
		progress: number
		text: string
		acknowledgedPackets?: number
		totalPackets?: number
	}> = []

	const plan = await planTerminalBleUpload(
		input.core,
		input.runtimeInfo,
		input.projectPath,
		input.code,
		input.target.deviceId
	)
	if (!plan.ready || !plan.startCommandBase64 || !plan.stopCommandBase64) {
		return {
			plan,
			result: {
				success: false,
				message: plan.message,
				errorCode: 'not-ready' as const,
				progressEventCount: 0,
				latestProgressText: 'not-ready'
			},
			progressEvents
		}
	}

	const result = await executeBleOtaUpload({
		deviceId: input.target.deviceId,
		startCommandBase64: plan.startCommandBase64,
		stopCommandBase64: plan.stopCommandBase64,
		packets: plan.packets,
		onProgress: progress => {
			progressEvents.push(progress)
			input.onProgress?.(progress)
		}
	})

	return {
		plan,
		result,
		progressEvents
	}
}
