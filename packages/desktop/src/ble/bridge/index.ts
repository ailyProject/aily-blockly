import { setupDesktopBlePermissions } from './permissions'
import {
	clearDesktopBlePendingSender,
	emitDesktopBleDeviceList,
	finishDesktopBleSelection,
	getDesktopBleDebugState,
	getDesktopBlePreferredDevice,
	hasDesktopBlePendingSelection,
	isDesktopBleRequestCancelled,
	markDesktopBleRequestCancelled,
	normalizeDesktopBleDevices,
	setDesktopBlePendingSelection,
	setDesktopBlePreferredDevice,
	startDesktopBleDeviceListUpdates,
	stopDesktopBleDeviceListUpdates,
	subscribeDesktopBleDeviceList
} from './state'

import type { DesktopBleBridge } from '../types'

let handlersRegistered = false

/**
 * 创建 desktop BLE chooser bridge。
 */
export const createDesktopBleBridge = (): DesktopBleBridge => ({
	registerChooser(window) {
		const sender = window.webContents
		setupDesktopBlePermissions(sender.session)
		sender.on('select-bluetooth-device', (event, deviceList, callback) => {
			event.preventDefault()
			setDesktopBlePendingSelection(sender, callback)

			if (isDesktopBleRequestCancelled(sender)) {
				finishDesktopBleSelection('')
				return
			}

			const preferredId = getDesktopBlePreferredDevice(sender)
			const normalized = normalizeDesktopBleDevices(deviceList as Array<unknown>)
			if (preferredId && normalized.some(device => device.deviceId === preferredId)) {
				finishDesktopBleSelection(preferredId)
				return
			}

			emitDesktopBleDeviceList(sender, deviceList as Array<unknown>)
		})

		window.on('closed', () => {
			clearDesktopBlePendingSender(sender)
		})
	},
	registerHandlers() {
		if (handlersRegistered) return
		handlersRegistered = true
	},
	hasPendingSelection(sender) {
		return hasDesktopBlePendingSelection(sender)
	},
	subscribeDeviceList(sender, listener) {
		return subscribeDesktopBleDeviceList(sender, listener)
	},
	async selectDevice(_sender, deviceId) {
		if (!getDesktopBleDebugState().hasPendingSelection) {
			return { success: false, error: 'No active BLE device selection request' }
		}

		finishDesktopBleSelection(deviceId || '')
		return { success: true }
	},
	async setPreferredDevice(sender, deviceId) {
		setDesktopBlePreferredDevice(sender, deviceId)
		return { success: true }
	},
	async cancelDeviceRequest(sender) {
		if (getDesktopBleDebugState().hasPendingSelection) {
			finishDesktopBleSelection('')
		} else {
			markDesktopBleRequestCancelled(sender)
		}
		return { success: true }
	},
	async startDeviceListUpdates(sender) {
		startDesktopBleDeviceListUpdates(sender)
		return { success: true }
	},
	async stopDeviceListUpdates(sender) {
		stopDesktopBleDeviceListUpdates(sender)
		return { success: true }
	},
	async debugState(_sender) {
		return getDesktopBleDebugState()
	}
})
