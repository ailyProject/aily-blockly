import {
	calculateHardwareBleUploadCrc16,
	HARDWARE_BLE_UPLOAD_PACKET_CRC_SIZE,
	HARDWARE_BLE_UPLOAD_PACKET_HEADER_SIZE,
	HARDWARE_BLE_UPLOAD_SECTOR_SIZE,
	writeHardwareBleUploadUint16LE
} from './protocol'

import type { HardwareBleUploadPacket } from '../types'

/**
 * 将固件字节流切分成 BLE OTA 分片。
 * @param firmware - 固件完整字节流
 * @param packetSize - 协商后的单包大小
 */
export const createHardwareBleUploadPackets = (
	firmware: Uint8Array,
	packetSize: number
): Array<HardwareBleUploadPacket> => {
	const payloadSize = packetSize - HARDWARE_BLE_UPLOAD_PACKET_HEADER_SIZE
	const finalPayloadSize = packetSize - HARDWARE_BLE_UPLOAD_PACKET_HEADER_SIZE - HARDWARE_BLE_UPLOAD_PACKET_CRC_SIZE
	if (finalPayloadSize <= 0) {
		throw new Error(`BLE packet size is too small: ${packetSize}`)
	}

	const packets: Array<HardwareBleUploadPacket> = []
	const sectorCount = Math.ceil(firmware.byteLength / HARDWARE_BLE_UPLOAD_SECTOR_SIZE)
	for (let sectorIndex = 0; sectorIndex < sectorCount; sectorIndex += 1) {
		const sectorStart = sectorIndex * HARDWARE_BLE_UPLOAD_SECTOR_SIZE
		const sector = firmware.subarray(
			sectorStart,
			Math.min(sectorStart + HARDWARE_BLE_UPLOAD_SECTOR_SIZE, firmware.byteLength)
		)
		const sectorCrc = calculateHardwareBleUploadCrc16(sector)
		let offset = 0
		let sequence = 0

		while (offset < sector.byteLength) {
			const remaining = sector.byteLength - offset
			const isLast = remaining <= finalPayloadSize
			let chunkSize = isLast ? remaining : Math.min(payloadSize, remaining)
			if (!isLast && remaining - chunkSize === 0) {
				chunkSize = remaining - finalPayloadSize
			}

			const bytes = new Uint8Array(
				HARDWARE_BLE_UPLOAD_PACKET_HEADER_SIZE + chunkSize + (isLast ? HARDWARE_BLE_UPLOAD_PACKET_CRC_SIZE : 0)
			)
			writeHardwareBleUploadUint16LE(bytes, 0, sectorIndex)
			bytes[2] = isLast ? 0xff : sequence++
			bytes.set(sector.subarray(offset, offset + chunkSize), HARDWARE_BLE_UPLOAD_PACKET_HEADER_SIZE)
			if (isLast) {
				writeHardwareBleUploadUint16LE(bytes, HARDWARE_BLE_UPLOAD_PACKET_HEADER_SIZE + chunkSize, sectorCrc)
			}

			packets.push({ sectorIndex, sequence: bytes[2], isLast, bytes })
			offset += chunkSize
		}
	}

	return packets
}
