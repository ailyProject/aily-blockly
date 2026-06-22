import { BLE_PACKET_SIZE_CANDIDATES, openBleOtaSession, writeCharacteristic } from './ble-upload.shared'

/**
 * 探测当前 BLE 设备支持的最大 packet size。
 * @param deviceId - 已授权设备 ID
 */
export const probeBleOtaPacketSize = async (deviceId: string) => {
	const { device, recv } = await openBleOtaSession(deviceId)

	try {
		for (const candidate of BLE_PACKET_SIZE_CANDIDATES) {
			try {
				await writeCharacteristic(recv, new Uint8Array(candidate), true)
				return candidate
			} catch {
				// try next candidate
			}
		}

		return 20
	} finally {
		try {
			device.gatt?.disconnect()
		} catch {
			// ignore cleanup failure
		}
	}
}
