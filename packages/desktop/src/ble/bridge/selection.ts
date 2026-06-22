import {
	cancelledRequests,
	clearPendingDesktopBleSelection,
	lastDeviceSignatures,
	pausedDeviceUpdates,
	pendingSelectionCallback,
	pendingSelectionSender,
	preferredSelections,
	setPendingDesktopBleSelection
} from './shared'

import type { WebContents } from 'electron'

/**
 * 结束当前 BLE 设备选择流程。
 * @param deviceId - 最终选中的设备 ID；空串表示取消
 */
export const finishDesktopBleSelection = (deviceId = '') => {
	if (!pendingSelectionCallback) return

	if (pendingSelectionSender) {
		preferredSelections.delete(pendingSelectionSender)
		pausedDeviceUpdates.delete(pendingSelectionSender)
		cancelledRequests.delete(pendingSelectionSender)
	}

	pendingSelectionCallback(deviceId)
	clearPendingDesktopBleSelection()
}

/**
 * 记录当前待处理的 BLE 选择回调。
 * @param sender - 当前窗口 sender
 * @param callback - Electron chooser 回调
 */
export const setDesktopBlePendingSelection = (sender: WebContents, callback: (deviceId: string) => void) =>
	setPendingDesktopBleSelection(sender, callback)

/**
 * 获取指定 sender 的首选设备 ID。
 * @param sender - 当前窗口 sender
 */
export const getDesktopBlePreferredDevice = (sender: WebContents) => preferredSelections.get(sender)

/**
 * 判断 sender 是否已被标记为取消当前选择请求。
 * @param sender - 当前窗口 sender
 */
export const isDesktopBleRequestCancelled = (sender: WebContents) => cancelledRequests.has(sender)

/**
 * 清理 sender 关联的待处理状态。
 * @param sender - 当前窗口 sender
 */
export const clearDesktopBlePendingSender = (sender: WebContents) => {
	if (pendingSelectionSender === sender) {
		clearPendingDesktopBleSelection()
	}
}

/**
 * 判断当前 sender 是否仍有待处理的选择请求。
 * @param sender - 当前窗口 sender
 */
export const hasDesktopBlePendingSelection = (sender: WebContents) =>
	pendingSelectionSender === sender && !!pendingSelectionCallback

/**
 * 更新 sender 的首选设备 ID。
 * @param sender - 当前窗口 sender
 * @param deviceId - 首选设备 ID
 */
export const setDesktopBlePreferredDevice = (sender: WebContents, deviceId: string) => {
	if (!deviceId) {
		preferredSelections.delete(sender)
		return
	}

	preferredSelections.set(sender, deviceId)
	pausedDeviceUpdates.delete(sender)
	cancelledRequests.delete(sender)
	lastDeviceSignatures.delete(sender)
}

/**
 * 标记当前 sender 的设备请求已取消。
 * @param sender - 当前窗口 sender
 */
export const markDesktopBleRequestCancelled = (sender: WebContents) => {
	preferredSelections.delete(sender)
	cancelledRequests.add(sender)
}

/**
 * 开始允许 sender 接收设备列表更新。
 * @param sender - 当前窗口 sender
 */
export const startDesktopBleDeviceListUpdates = (sender: WebContents) => {
	preferredSelections.delete(sender)
	pausedDeviceUpdates.delete(sender)
	cancelledRequests.delete(sender)
	lastDeviceSignatures.delete(sender)
}

/**
 * 暂停 sender 的设备列表更新。
 * @param sender - 当前窗口 sender
 */
export const stopDesktopBleDeviceListUpdates = (sender: WebContents) => {
	pausedDeviceUpdates.add(sender)
}

/**
 * 返回当前 BLE chooser 调试态。
 */
export const getDesktopBleDebugState = () => ({
	hasPendingSelection: !!pendingSelectionCallback,
	preferredDeviceId: pendingSelectionSender ? preferredSelections.get(pendingSelectionSender) || '' : '',
	deviceListUpdatesPaused: pendingSelectionSender ? pausedDeviceUpdates.has(pendingSelectionSender) : false
})
