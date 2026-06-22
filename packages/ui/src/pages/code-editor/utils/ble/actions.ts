import { authorizeBleOtaDevice, getPreferredBleDeviceId, subscribeBleDevices } from '@/utils/desktop'

import { runCodeEditorBleUpload } from './execute'
import { detectCodeEditorBlePacketSize, loadCodeEditorBleUploadPlan } from './plan'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { CodeEditorSignals } from '../../types'

/**
 * 选择 BLE 设备。
 */
export const selectCodeEditorBleDevice = async (input: {
	desktop: NonNullable<Desktop> | null
	signals: CodeEditorSignals
}) => {
	input.signals.buildError.set(null)
	try {
		const device = await authorizeBleOtaDevice(input.desktop, input.signals.bleDevice()?.deviceId)
		input.signals.bleDevice.set(device)
		input.signals.bleUploadPlan.set(null)
	} catch (error) {
		input.signals.buildError.set(error instanceof Error ? error.message : String(error))
	}
}

/**
 * 准备 BLE 上传计划。
 */
export const prepareCodeEditorBleUpload = async (input: { core: Core; signals: CodeEditorSignals }) => {
	const runtimeInfo = input.signals.runtimeInfo()
	const projectPath = input.signals.projectPath().trim()
	const bleDeviceId = input.signals.bleDevice()?.deviceId || ''
	if (!runtimeInfo || !projectPath || !bleDeviceId) return

	input.signals.uploadBusy.set(true)
	input.signals.buildError.set(null)
	try {
		const packetSize = await detectCodeEditorBlePacketSize(bleDeviceId).catch(() => undefined)
		input.signals.bleUploadPlan.set(
			await loadCodeEditorBleUploadPlan(input.core, runtimeInfo, projectPath, input.signals.sourceCode(), packetSize)
		)
	} catch (error) {
		input.signals.bleUploadPlan.set(null)
		input.signals.buildError.set(error instanceof Error ? error.message : String(error))
	} finally {
		input.signals.uploadBusy.set(false)
	}
}

/**
 * 执行 BLE 上传动作。
 */
export const runCodeEditorBleUploadAction = async (input: { signals: CodeEditorSignals }) => {
	const plan = input.signals.bleUploadPlan()
	const deviceId = input.signals.bleDevice()?.deviceId || ''
	if (!plan || !deviceId) return

	input.signals.uploadBusy.set(true)
	input.signals.buildError.set(null)
	input.signals.bleUploadProgress.set(null)
	try {
		input.signals.uploadResult.set(
			await runCodeEditorBleUpload(plan, deviceId, progress => {
				input.signals.bleUploadProgress.set(progress)
			})
		)
	} catch (error) {
		input.signals.uploadResult.set(null)
		input.signals.buildError.set(error instanceof Error ? error.message : String(error))
	} finally {
		input.signals.uploadBusy.set(false)
	}
}

/**
 * 订阅 BLE 设备列表。
 */
export const startCodeEditorBleDiscovery = (input: {
	desktop: NonNullable<Desktop> | null
	signals: CodeEditorSignals
}) => {
	if (!input.signals.bleBridgeAvailable()) return null

	return subscribeBleDevices(
		input.desktop,
		devices => {
			input.signals.bleDevices.set(devices)
			const currentDeviceId = input.signals.bleDevice()?.deviceId || ''
			const preferredDeviceId = getPreferredBleDeviceId()
			const nextDevice =
				devices.find(device => device.deviceId === currentDeviceId) ??
				devices.find(device => device.deviceId === preferredDeviceId) ??
				devices[0] ??
				null
			input.signals.bleDevice.set(nextDevice)
		},
		error => {
			input.signals.buildError.set(error instanceof Error ? error.message : String(error))
		}
	)
}
