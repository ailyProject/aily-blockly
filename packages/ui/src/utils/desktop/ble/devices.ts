import {
	getDesktopBluetooth,
	readDesktopBleDevice,
	readDesktopPreferredBleDeviceId,
	rememberDesktopBleDevice,
	writeDesktopPreferredBleDeviceId
} from './shared'

import type { BleDeviceItem } from 'shared'

/**
 * 读取当前本地持久化的 BLE 首选设备 ID。
 */
export const getPreferredBleDeviceId = () => readDesktopPreferredBleDeviceId()

/**
 * 尝试恢复当前浏览器环境中已授权的 BLE 设备列表。
 */
export const loadAuthorizedBleOtaDevices = async (): Promise<Array<BleDeviceItem>> => {
	const bluetooth = getDesktopBluetooth()
	if (!bluetooth?.getDevices) return []

	try {
		const devices = await bluetooth.getDevices()
		const normalizedDevices = devices
			.filter(device => Boolean(device?.id))
			.map(device => {
				rememberDesktopBleDevice(device)
				return {
					deviceId: device.id,
					deviceName: device.name || 'BLE OTA Device'
				}
			})

		if (
			readDesktopPreferredBleDeviceId() &&
			!normalizedDevices.some(device => device.deviceId === readDesktopPreferredBleDeviceId())
		) {
			writeDesktopPreferredBleDeviceId('')
		}

		return normalizedDevices
	} catch {
		return []
	}
}

/**
 * 读取当前已授权的 BLE 设备对象。
 * @param deviceId - 设备 ID
 */
export const getAuthorizedBleOtaDevice = (deviceId?: string) => {
	const targetId = (deviceId || readDesktopPreferredBleDeviceId() || '').trim()
	return targetId ? readDesktopBleDevice(targetId) : null
}
