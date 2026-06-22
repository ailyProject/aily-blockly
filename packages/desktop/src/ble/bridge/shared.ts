import type { WebContents } from 'electron'
import type { BleDeviceItem } from '../types'

export let pendingSelectionCallback: ((deviceId: string) => void) | null = null
export let pendingSelectionSender: WebContents | null = null
export const lastDeviceSignatures = new WeakMap<WebContents, string>()
export const pausedDeviceUpdates = new WeakSet<WebContents>()
export const cancelledRequests = new WeakSet<WebContents>()
export const preferredSelections = new WeakMap<WebContents, string>()
export const deviceListListeners = new WeakMap<WebContents, Set<(devices: Array<BleDeviceItem>) => void>>()

/**
 * 设置当前待处理的 BLE 选择回调。
 * @param sender - 当前窗口 sender
 * @param callback - Electron chooser 回调
 */
export const setPendingDesktopBleSelection = (sender: WebContents, callback: (deviceId: string) => void) => {
	pendingSelectionCallback = callback
	pendingSelectionSender = sender
}

/**
 * 清理当前待处理的 BLE 选择回调。
 */
export const clearPendingDesktopBleSelection = () => {
	pendingSelectionCallback = null
	pendingSelectionSender = null
}
