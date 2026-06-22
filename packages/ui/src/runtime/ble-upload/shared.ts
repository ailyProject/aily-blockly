import { getAuthorizedBleOtaDevice } from '@/utils/desktop'

import type { BleCharacteristic, BleDevice } from './types'

export const BLE_OTA_SERVICE_UUID = '00008018-0000-1000-8000-00805f9b34fb'
export const BLE_OTA_RECV_FW_CHAR_UUID = '00008020-0000-1000-8000-00805f9b34fb'
export const BLE_OTA_COMMAND_CHAR_UUID = '00008022-0000-1000-8000-00805f9b34fb'
export const COMMAND_ACK_TIMEOUT_MS = 15000
export const SECTOR_ACK_TIMEOUT_MS = 15000
export const BLE_PACKET_SIZE_CANDIDATES = [510, 247, 185, 122, 23]
export const ACK_OK = 0x0000
export const ACK_CRC_ERROR = 0x0001
export const ACK_INDEX_ERROR = 0x0002
export const ACK_SIGNATURE_ERROR = 0x0003
export const ACK_START_ERROR = 0x0005

export const decodeBase64 = (value: string) => Uint8Array.from(atob(value), item => item.charCodeAt(0))
export const readUint16LE = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8)

export const crc16 = (bytes: Uint8Array) => {
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

export const getEventBytes = (event: Event) => {
	const value = (event.target as { value?: DataView })?.value
	return value
		? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
		: new Uint8Array()
}

export const isValidFrame = (bytes: Uint8Array) =>
	bytes.byteLength >= 4 && crc16(bytes.subarray(0, bytes.byteLength - 2)) === readUint16LE(bytes, bytes.byteLength - 2)

export const formatBleAckError = (status: number, commandId?: number) => {
	const prefix = typeof commandId === 'number' ? `BLE command 0x${commandId.toString(16)} ` : 'BLE transfer '
	if (status === ACK_CRC_ERROR) return `${prefix}failed: CRC error`
	if (status === ACK_INDEX_ERROR) return `${prefix}failed: packet index error`
	if (status === ACK_SIGNATURE_ERROR) return `${prefix}failed: signature error`
	if (status === ACK_START_ERROR) return `${prefix}failed: start error`
	return `${prefix}failed: status 0x${status.toString(16)}`
}

export const writeCharacteristic = async (
	characteristic: BleCharacteristic,
	bytes: Uint8Array,
	withoutResponse: boolean
) => {
	const value = Uint8Array.from(bytes)
	if (withoutResponse && characteristic.writeValueWithoutResponse) {
		await characteristic.writeValueWithoutResponse(value)
		return
	}
	if (!withoutResponse && characteristic.writeValueWithResponse) {
		await characteristic.writeValueWithResponse(value)
		return
	}
	await characteristic.writeValue(value)
}

export const openBleOtaSession = async (deviceId: string) => {
	const device = getAuthorizedBleOtaDevice(deviceId) as BleDevice | null
	if (!device?.gatt) throw new Error('BLE device is not authorized.')

	const server = await device.gatt.connect()
	const service = await server.getPrimaryService(BLE_OTA_SERVICE_UUID)
	const recv = await service.getCharacteristic(BLE_OTA_RECV_FW_CHAR_UUID)
	const command = await service.getCharacteristic(BLE_OTA_COMMAND_CHAR_UUID)

	return {
		device,
		recv,
		command
	}
}
