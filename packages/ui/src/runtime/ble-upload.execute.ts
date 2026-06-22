import { waitForBleCommandAck, waitForBleSectorAck } from './ble-upload.acks'
import { classifyBleUploadError } from './ble-upload.errors'
import { decodeBase64, openBleOtaSession, writeCharacteristic } from './ble-upload.shared'

import type { BleOtaExecutionProgress, BleOtaExecutionResult } from './ble-upload.types'

/**
 * 执行 BLE OTA 上传。
 * @param input - 已准备好的 BLE 设备与上传计划
 */
export const executeBleOtaUpload = async (input: {
	deviceId: string
	startCommandBase64: string
	stopCommandBase64: string
	packets: Array<{ sectorIndex: number; isLast: boolean; bytesBase64: string }>
	retries?: number
	onProgress?: (progress: BleOtaExecutionProgress) => void
}): Promise<BleOtaExecutionResult> => {
	const retries = input.retries ?? 2
	const { device, recv, command } = await openBleOtaSession(input.deviceId)
	await Promise.all([recv.startNotifications(), command.startNotifications()])

	let progressEventCount = 0
	let latestProgressText = 'starting'
	input.onProgress?.({
		phase: 'starting',
		progress: 1,
		text: 'starting BLE OTA'
	})

	try {
		await writeCharacteristic(command, decodeBase64(input.startCommandBase64), true)
		await waitForBleCommandAck(command, 0x0001)
		input.onProgress?.({
			phase: 'sending',
			progress: 2,
			text: 'sending firmware',
			acknowledgedPackets: 0,
			totalPackets: input.packets.length
		})
		for (const packet of input.packets) {
			let attempt = 0
			for (;;) {
				try {
					await writeCharacteristic(recv, decodeBase64(packet.bytesBase64), true)
					if (packet.isLast) {
						await waitForBleSectorAck(recv, packet.sectorIndex)
						progressEventCount += 1
						latestProgressText = `sending ${packet.sectorIndex + 1}`
						const progress = Math.max(2, Math.min(98, Math.floor((progressEventCount / input.packets.length) * 98)))
						input.onProgress?.({
							phase: 'sending',
							progress,
							text: `sending sector ${packet.sectorIndex + 1}`,
							acknowledgedPackets: progressEventCount,
							totalPackets: input.packets.length
						})
					}
					break
				} catch (error) {
					attempt += 1
					if (attempt > retries) throw error
					input.onProgress?.({
						phase: 'sending',
						progress: Math.max(2, Math.min(98, Math.floor((progressEventCount / input.packets.length) * 98))),
						text: `retrying sector ${packet.sectorIndex + 1} (${attempt}/${retries})`,
						acknowledgedPackets: progressEventCount,
						totalPackets: input.packets.length
					})
				}
			}
		}
		input.onProgress?.({
			phase: 'stopping',
			progress: 99,
			text: 'stopping and verifying'
		})
		await writeCharacteristic(command, decodeBase64(input.stopCommandBase64), true)
		await waitForBleCommandAck(command, 0x0002)
		input.onProgress?.({
			phase: 'done',
			progress: 100,
			text: 'BLE OTA complete',
			acknowledgedPackets: progressEventCount,
			totalPackets: input.packets.length
		})

		return {
			success: true,
			errorCode: undefined,
			message: 'BLE OTA complete',
			progressEventCount,
			latestProgressText: 'done'
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		input.onProgress?.({
			phase: 'error',
			progress: Math.max(1, Math.min(99, Math.floor((progressEventCount / Math.max(input.packets.length, 1)) * 100))),
			text: message,
			acknowledgedPackets: progressEventCount,
			totalPackets: input.packets.length
		})
		return {
			success: false,
			errorCode: classifyBleUploadError(error),
			message,
			progressEventCount,
			latestProgressText: 'error'
		}
	} finally {
		try {
			device.gatt?.disconnect()
		} catch {
			// ignore disconnect failures during cleanup
		}
	}
}
