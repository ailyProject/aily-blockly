import { readFileSync } from 'node:fs'

import { resolveHardwareBleUploadFirmwareFile } from './firmware'
import { createHardwareBleUploadPackets } from './packets'

import type { HardwareBleUploadPreparation } from '../types'

const DEFAULT_BLE_PACKET_SIZE = 185

/**
 * 解析当前项目 BLE OTA 上传前置状态。
 * @param buildPath - 当前构建输出目录
 */
export const resolveHardwareBleUploadPreparation = (buildPath: string): HardwareBleUploadPreparation => {
	const firmwarePath = resolveHardwareBleUploadFirmwareFile(buildPath)
	if (!firmwarePath) {
		return {
			ready: false,
			updateType: 'flash',
			message: '未找到可用于 BLE OTA 的固件产物'
		}
	}

	const firmwareBytes = new Uint8Array(readFileSync(firmwarePath))
	const packets = createHardwareBleUploadPackets(firmwareBytes, DEFAULT_BLE_PACKET_SIZE)
	return {
		ready: true,
		updateType: 'flash',
		firmwarePath,
		packetSize: DEFAULT_BLE_PACKET_SIZE,
		packetCount: packets.length,
		message: `BLE OTA 固件已就绪，共 ${packets.length} 个分片`
	}
}
