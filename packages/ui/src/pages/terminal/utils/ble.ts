import { authorizeBleOtaDevice, getPreferredBleDeviceId, subscribeBleDevices } from '@/utils/desktop'

import type { Desktop } from '@/utils/desktop'
import type { WritableSignal } from '@angular/core'
import type { Unsubscribable } from '@trpc/server/observable'
import type { TerminalUploadTargetOption } from './types'

const buildTerminalBleTargets = (devices: Array<{ deviceId: string; deviceName: string }>) =>
	devices.map(device => ({
		id: `ble:${device.deviceId}`,
		portType: 'ble' as const,
		label: device.deviceName || device.deviceId,
		deviceId: device.deviceId
	}))

/**
 * 为 terminal 页面启动 BLE 设备发现订阅。
 * @param input - desktop 句柄、signals 与错误回调
 */
export const startTerminalBleDiscovery = (input: {
	desktop: NonNullable<Desktop> | null
	uploadTargets: WritableSignal<Array<TerminalUploadTargetOption>>
	selectedUploadTargetId: WritableSignal<string>
	onError: (error: unknown) => void
	chooseUploadTarget: (targetId: string) => Promise<void>
}): Unsubscribable | null => {
	if (!input.desktop) return null

	return subscribeBleDevices(
		input.desktop,
		devices => {
			const currentTargets = input.uploadTargets()
			const nonBleTargets = currentTargets.filter(target => target.portType !== 'ble')
			const bleTargets = buildTerminalBleTargets(devices)
			const nextTargets = [...nonBleTargets, ...bleTargets]
			input.uploadTargets.set(nextTargets)

			const currentSelectedTargetId = input.selectedUploadTargetId()
			if (!nextTargets.some(target => target.id === currentSelectedTargetId)) {
				const preferredBleDeviceId = getPreferredBleDeviceId()
				const nextTarget =
					bleTargets.find(target => target.deviceId === preferredBleDeviceId) ??
					bleTargets[0] ??
					nonBleTargets[0] ??
					null

				void input.chooseUploadTarget(nextTarget?.id || '')
			}
		},
		input.onError
	)
}

/**
 * 在 terminal 页面中发起 BLE 设备选择。
 * @param input - desktop 句柄、当前目标与错误回调
 */
export const selectTerminalBleDevice = async (input: {
	desktop: NonNullable<Desktop> | null
	uploadTargets: WritableSignal<Array<TerminalUploadTargetOption>>
	selectedUploadTargetId: WritableSignal<string>
	chooseUploadTarget: (targetId: string) => Promise<void>
	onError: (error: unknown) => void
}) => {
	try {
		const device = await authorizeBleOtaDevice(input.desktop, undefined)
		const targetId = `ble:${device.deviceId}`
		input.uploadTargets.update(current => {
			const nextTarget = {
				id: targetId,
				portType: 'ble' as const,
				label: device.deviceName || device.deviceId,
				deviceId: device.deviceId
			}
			const others = current.filter(item => item.id !== targetId && item.portType !== 'ble')
			return [...others, nextTarget]
		})
		await input.chooseUploadTarget(targetId)
	} catch (error) {
		input.onError(error)
	}
}
