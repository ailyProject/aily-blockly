import type { HardwareBleUploadAckStatus, HardwareBleUploadCommandId, HardwareBleUploadUpdateType } from '../types'

export const HARDWARE_BLE_UPLOAD_SECTOR_SIZE = 4096
export const HARDWARE_BLE_UPLOAD_COMMAND_FRAME_SIZE = 20
export const HARDWARE_BLE_UPLOAD_PACKET_HEADER_SIZE = 3
export const HARDWARE_BLE_UPLOAD_PACKET_CRC_SIZE = 2
export const HARDWARE_BLE_UPLOAD_ACK_OK: HardwareBleUploadAckStatus = 0x0000
export const HARDWARE_BLE_UPLOAD_ACK_INDEX_ERROR: HardwareBleUploadAckStatus = 0x0002
export const HARDWARE_BLE_UPLOAD_CMD_START_FLASH: HardwareBleUploadCommandId = 0x0001
export const HARDWARE_BLE_UPLOAD_CMD_STOP: HardwareBleUploadCommandId = 0x0002
export const HARDWARE_BLE_UPLOAD_CMD_START_FILESYSTEM: HardwareBleUploadCommandId = 0x0004

/**
 * 计算 BLE OTA 使用的 CRC16-CCITT。
 * @param bytes - 需要校验的字节序列
 */
export const calculateHardwareBleUploadCrc16 = (bytes: Uint8Array) => {
	let crc = 0x0000
	for (const byte of bytes) {
		crc ^= byte << 8
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
			crc &= 0xffff
		}
	}
	return crc & 0xffff
}

/**
 * 读取小端 16 位整数。
 * @param bytes - 源字节数组
 * @param offset - 读取偏移
 */
export const readHardwareBleUploadUint16LE = (bytes: Uint8Array, offset: number) =>
	bytes[offset] | (bytes[offset + 1] << 8)

/**
 * 向指定偏移写入小端 16 位整数。
 * @param bytes - 目标字节数组
 * @param offset - 写入偏移
 * @param value - 要写入的值
 */
export const writeHardwareBleUploadUint16LE = (bytes: Uint8Array, offset: number, value: number) => {
	bytes[offset] = value & 0xff
	bytes[offset + 1] = (value >> 8) & 0xff
}

/**
 * 向指定偏移写入小端 32 位整数。
 * @param bytes - 目标字节数组
 * @param offset - 写入偏移
 * @param value - 要写入的值
 */
export const writeHardwareBleUploadUint32LE = (bytes: Uint8Array, offset: number, value: number) => {
	bytes[offset] = value & 0xff
	bytes[offset + 1] = (value >> 8) & 0xff
	bytes[offset + 2] = (value >> 16) & 0xff
	bytes[offset + 3] = (value >> 24) & 0xff
}

/**
 * 构建 BLE OTA 命令帧。
 * @param updateType - 更新类型
 * @param totalSize - 固件总大小
 */
export const buildHardwareBleUploadCommandFrame = (updateType: HardwareBleUploadUpdateType, totalSize: number) => {
	const frame = new Uint8Array(HARDWARE_BLE_UPLOAD_COMMAND_FRAME_SIZE)
	const commandId =
		updateType === 'filesystem' ? HARDWARE_BLE_UPLOAD_CMD_START_FILESYSTEM : HARDWARE_BLE_UPLOAD_CMD_START_FLASH
	writeHardwareBleUploadUint16LE(frame, 0, commandId)
	writeHardwareBleUploadUint32LE(frame, 2, totalSize)
	writeHardwareBleUploadUint16LE(frame, 18, calculateHardwareBleUploadCrc16(frame.subarray(0, 18)))
	return frame
}

/**
 * 构建 BLE OTA 停止命令帧。
 */
export const buildHardwareBleUploadStopFrame = () => {
	const frame = new Uint8Array(HARDWARE_BLE_UPLOAD_COMMAND_FRAME_SIZE)
	writeHardwareBleUploadUint16LE(frame, 0, HARDWARE_BLE_UPLOAD_CMD_STOP)
	writeHardwareBleUploadUint16LE(frame, 18, calculateHardwareBleUploadCrc16(frame.subarray(0, 18)))
	return frame
}

/**
 * 判断收到的 BLE ACK 帧 CRC 是否有效。
 * @param frame - 原始帧数据
 */
export const isHardwareBleUploadFrameValid = (frame: Uint8Array) =>
	frame.byteLength >= 4 &&
	calculateHardwareBleUploadCrc16(frame.subarray(0, frame.byteLength - 2)) ===
		readHardwareBleUploadUint16LE(frame, frame.byteLength - 2)
