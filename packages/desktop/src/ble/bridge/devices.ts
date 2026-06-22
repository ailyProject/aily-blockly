import { deviceListListeners, lastDeviceSignatures, pausedDeviceUpdates } from './shared'

import type { WebContents } from 'electron'
import type { BleDeviceItem, DesktopBleRawDevice } from '../types'

/**
 * 规整 Electron 返回的原始 BLE 设备列表。
 * @param deviceList - Electron chooser 返回的原始设备列表
 */
export const normalizeDesktopBleDevices = (deviceList: Array<unknown> = []): Array<BleDeviceItem> => {
	const devices = new Map<string, BleDeviceItem>()
	for (const rawDevice of deviceList as Array<DesktopBleRawDevice>) {
		const deviceId = String(
			rawDevice['deviceId'] || rawDevice['id'] || rawDevice['device_id'] || rawDevice['address'] || ''
		)
		if (!deviceId) continue

		devices.set(deviceId, {
			deviceId,
			deviceName: String(rawDevice['deviceName'] || rawDevice['name'] || rawDevice['device_name'] || 'BLE OTA Device')
		})
	}

	return [...devices.values()]
}

/**
 * 向指定 sender 广播设备列表变化。
 * @param sender - 当前窗口 webContents
 * @param deviceList - 原始设备列表
 */
export const emitDesktopBleDeviceList = (sender: WebContents, deviceList: Array<unknown>) => {
	if (sender.isDestroyed() || pausedDeviceUpdates.has(sender)) return

	const normalized = normalizeDesktopBleDevices(deviceList)
	const signature = JSON.stringify(normalized.map(device => `${device.deviceId}:${device.deviceName}`))
	if (lastDeviceSignatures.get(sender) === signature) return

	lastDeviceSignatures.set(sender, signature)
	for (const listener of deviceListListeners.get(sender) ?? []) {
		listener(normalized)
	}
}

/**
 * 订阅某个 sender 的设备列表更新。
 * @param sender - 当前窗口 sender
 * @param listener - 设备列表回调
 */
export const subscribeDesktopBleDeviceList = (
	sender: WebContents,
	listener: (devices: Array<BleDeviceItem>) => void
) => {
	const listeners = deviceListListeners.get(sender) ?? new Set()
	listeners.add(listener)
	deviceListListeners.set(sender, listeners)
	return () => {
		listeners.delete(listener)
	}
}
