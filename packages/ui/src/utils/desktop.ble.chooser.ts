import {
	getDesktopBleOtaServiceUuid,
	getDesktopBluetooth,
	readDesktopPreferredBleDeviceId,
	rememberDesktopBleDevice,
	writeDesktopPreferredBleDeviceId
} from './desktop.ble.shared'

import type { BleDeviceItem } from 'shared'
import type { Desktop } from './desktop'

/**
 * 判断当前运行时是否存在 desktop BLE chooser bridge。
 * @param desktop - desktop ERPC 句柄
 */
export const hasBleChooserBridge = (desktop: NonNullable<Desktop> | null) =>
	!!desktop && typeof window !== 'undefined' && !!getDesktopBluetooth()?.requestDevice

/**
 * 通过 `desktop.ble.*` chooser bridge + Web Bluetooth 授权一个 BLE OTA 设备。
 * @param desktop - desktop ERPC 句柄
 * @param preferredDeviceId - 希望优先选中的设备 ID
 */
export const authorizeBleOtaDevice = async (
	desktop: NonNullable<Desktop> | null,
	preferredDeviceId?: string
): Promise<BleDeviceItem> => {
	if (!desktop || !getDesktopBluetooth()?.requestDevice) {
		throw new Error('BLE chooser bridge is unavailable.')
	}

	await desktop.ble.startDeviceListUpdates.mutate()
	const nextPreferredDeviceId = (preferredDeviceId || readDesktopPreferredBleDeviceId()).trim()
	if (nextPreferredDeviceId) {
		await desktop.ble.setPreferredDevice.mutate({ deviceId: nextPreferredDeviceId })
	}

	try {
		const device = await getDesktopBluetooth()!.requestDevice({
			filters: [{ services: [getDesktopBleOtaServiceUuid()] }],
			optionalServices: [getDesktopBleOtaServiceUuid()]
		})
		rememberDesktopBleDevice(device)
		writeDesktopPreferredBleDeviceId(device.id)
		return {
			deviceId: device.id,
			deviceName: device.name || 'BLE OTA Device'
		}
	} finally {
		await desktop.ble.stopDeviceListUpdates.mutate().catch(() => ({ success: false }))
	}
}

/**
 * 订阅 desktop 侧 BLE 设备列表。
 * @param desktop - desktop ERPC 句柄
 * @param onData - 设备列表回调
 * @param onError - 错误回调
 */
export const subscribeBleDevices = (
	desktop: NonNullable<Desktop> | null,
	onData: (devices: Array<BleDeviceItem>) => void,
	onError: (error: unknown) => void
) => {
	if (!desktop) return null

	return desktop.ble.deviceList.subscribe(undefined, {
		onData: value => {
			onData(value as Array<BleDeviceItem>)
		},
		onError
	})
}
