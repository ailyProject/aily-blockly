import { readFileSync } from 'node:fs'
import path from 'node:path'

import { runProjectBuild } from '../../../build'
import { resolveHardwareUploadBuildPath } from '../buildPath'
import { resolveHardwareUploadContext } from '../context'
import { createHardwareBleUploadPackets } from './packets'
import { resolveHardwareBleUploadPreparation } from './preparation'
import { buildHardwareBleUploadCommandFrame, buildHardwareBleUploadStopFrame } from './protocol'

import type { HardwareBleUploadExecutionPlan, HardwarePrepareBleUploadInput } from '../types'

const DEFAULT_BLE_PACKET_SIZE = 185
const encodeBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

/**
 * 构建 BLE OTA 上传执行计划。
 * @param input - BLE 上传准备输入
 */
export const prepareHardwareBleUpload = async (
	input: HardwarePrepareBleUploadInput
): Promise<HardwareBleUploadExecutionPlan> => {
	const buildResult = input.rebuildBeforeUpload
		? await runProjectBuild({
				projectPath: input.projectPath,
				appDataPath: input.appDataPath,
				childPath: input.childPath,
				code: input.code
			})
		: null

	if (buildResult && !buildResult.success) {
		const buildPath = resolveHardwareUploadBuildPath(path.join(input.projectPath, '.temp', 'sketch', 'sketch.ino'))
		return {
			ready: false,
			buildPath,
			builtBeforeUpload: true,
			updateType: input.updateType || 'flash',
			packetSize: input.packetSize || DEFAULT_BLE_PACKET_SIZE,
			totalBytes: 0,
			packetCount: 0,
			packets: [],
			message: buildResult.errorText || '构建失败，无法准备 BLE 上传'
		}
	}

	const context = resolveHardwareUploadContext({
		projectPath: input.projectPath,
		appDataPath: input.appDataPath,
		childPath: input.childPath,
		code: input.code,
		portType: 'ble',
		rebuildBeforeUpload: input.rebuildBeforeUpload
	})
	const preparation = resolveHardwareBleUploadPreparation(context.buildPath)
	if (!preparation.ready || !preparation.firmwarePath) {
		return {
			ready: false,
			buildPath: context.buildPath,
			artifactPath: preparation.firmwarePath,
			builtBeforeUpload: Boolean(buildResult),
			updateType: input.updateType || preparation.updateType,
			packetSize: input.packetSize || preparation.packetSize || DEFAULT_BLE_PACKET_SIZE,
			totalBytes: 0,
			packetCount: 0,
			packets: [],
			message: preparation.message
		}
	}

	const firmwareBytes = new Uint8Array(readFileSync(preparation.firmwarePath))
	const packetSize = input.packetSize || preparation.packetSize || DEFAULT_BLE_PACKET_SIZE
	const packets = createHardwareBleUploadPackets(firmwareBytes, packetSize)

	return {
		ready: true,
		buildPath: context.buildPath,
		artifactPath: preparation.firmwarePath,
		builtBeforeUpload: Boolean(buildResult),
		updateType: input.updateType || preparation.updateType,
		packetSize,
		totalBytes: firmwareBytes.byteLength,
		packetCount: packets.length,
		startCommandBase64: encodeBase64(
			buildHardwareBleUploadCommandFrame(input.updateType || preparation.updateType, firmwareBytes.byteLength)
		),
		stopCommandBase64: encodeBase64(buildHardwareBleUploadStopFrame()),
		packets: packets.map(packet => ({
			sectorIndex: packet.sectorIndex,
			sequence: packet.sequence,
			isLast: packet.isLast,
			bytesBase64: encodeBase64(packet.bytes)
		})),
		message: preparation.message
	}
}
