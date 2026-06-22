import { probeBleOtaPacketSize } from '@/runtime/ble-upload'

import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { CodeEditorBleUploadPlanView } from './types'

/**
 * 生成 BLE OTA 上传计划。
 * @param core - core 句柄
 * @param runtimeInfo - desktop 运行时信息
 * @param projectPath - 当前项目路径
 * @param code - 当前源码
 * @param packetSize - 可选包大小
 */
export const loadCodeEditorBleUploadPlan = async (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo,
	projectPath: string,
	code: string,
	packetSize?: number
): Promise<CodeEditorBleUploadPlanView> => {
	const plan = await core.hardware.prepareBleUpload.mutate({
		projectPath,
		appDataPath: runtimeInfo.appDataPath,
		childPath: runtimeInfo.childPath ?? '',
		code,
		rebuildBeforeUpload: true,
		packetSize
	})

	return {
		ready: plan.ready,
		artifactPath: plan.artifactPath,
		totalBytes: plan.totalBytes,
		packetSizeProbed: typeof packetSize === 'number',
		packetSize: plan.packetSize,
		packetCount: plan.packetCount,
		startCommandBase64: plan.startCommandBase64,
		stopCommandBase64: plan.stopCommandBase64,
		packets: plan.packets,
		message: plan.message
	}
}

/**
 * 探测当前 BLE 设备支持的 packet size。
 * @param deviceId - 当前 BLE 设备 ID
 */
export const detectCodeEditorBlePacketSize = (deviceId: string) => probeBleOtaPacketSize(deviceId)
