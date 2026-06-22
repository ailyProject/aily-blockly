import { getCurrentProjectPath, setCurrentProjectPath } from '@/runtime/project-session'
import { getPreferredBleDeviceId, loadAuthorizedBleOtaDevices } from '@/utils/desktop'

import {
	closeTerminalSession,
	createTerminalSession,
	loadTerminalSelectedUploadTargetId,
	loadTerminalUploadTargets,
	subscribeTerminalStream
} from '../../runtime'

import type { Core } from '@/utils/core'
import type { Desktop, SelectDesktopDirectory } from '@/utils/desktop'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { Unsubscribable } from '@trpc/server/observable'
import type { TerminalPageSignals } from '../../utils/types'

/**
 * 创建 terminal 生命周期相关动作。
 * @param input - terminal 状态、宿主依赖与输出动作
 */
export const createTerminalLifecycleActions = (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	signals: TerminalPageSignals
	selectDesktopDirectory: SelectDesktopDirectory
	loadDesktopHostRuntimeInfo: (desktop: NonNullable<Desktop>) => Promise<DesktopHostRuntimeInfo>
	appendOutput: (text: string) => void
	getSubscription: () => Unsubscribable | null
	setSubscription: (subscription: Unsubscribable | null) => void
}) => ({
	async initialize() {
		if (!input.desktop) {
			input.signals.error.set('Desktop bridge is unavailable.')
			input.signals.loading.set(false)
			return
		}

		try {
			const runtimeInfo = await input.loadDesktopHostRuntimeInfo(input.desktop)
			input.signals.runtimeInfo.set(runtimeInfo)
			const uploadTargets = await loadTerminalUploadTargets(input.core)
			const authorizedBleDevices = await loadAuthorizedBleOtaDevices()
			const preferredBleDeviceId = getPreferredBleDeviceId()
			const bleTargets = authorizedBleDevices.map(device => ({
				id: `ble:${device.deviceId}`,
				portType: 'ble' as const,
				label: device.deviceName || device.deviceId,
				deviceId: device.deviceId
			}))
			const nextUploadTargets = [...uploadTargets, ...bleTargets]
			input.signals.uploadTargets.set(uploadTargets)
			input.signals.selectedUploadTargetId.set(
				preferredBleDeviceId && bleTargets.some(target => target.deviceId === preferredBleDeviceId)
					? `ble:${preferredBleDeviceId}`
					: await loadTerminalSelectedUploadTargetId(input.core, runtimeInfo, nextUploadTargets)
			)
			input.signals.uploadTargets.set(nextUploadTargets)
			await this.openSession(getCurrentProjectPath() || undefined)
		} catch (error) {
			input.signals.error.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.signals.loading.set(false)
		}
	},
	async destroy() {
		input.getSubscription()?.unsubscribe()
		const sessionId = input.signals.session()?.id
		if (input.desktop && sessionId) {
			await closeTerminalSession(input.desktop, sessionId).catch(() => null)
		}
	},
	async chooseWorkingDirectory() {
		if (!input.desktop) return
		try {
			const nextPath = await input.selectDesktopDirectory(
				input.desktop,
				input.signals.session()?.cwd || getCurrentProjectPath() || ''
			)
			if (!nextPath) return
			setCurrentProjectPath(nextPath)
			input.signals.lines.set([])
			input.signals.lineCount.set(0)
			await this.openSession(nextPath)
		} catch (error) {
			input.signals.error.set(error instanceof Error ? error.message : String(error))
		}
	},
	async openSession(cwd?: string) {
		if (!input.desktop) return

		input.getSubscription()?.unsubscribe()
		const previousSessionId = input.signals.session()?.id
		if (previousSessionId) {
			await closeTerminalSession(input.desktop, previousSessionId).catch(() => null)
		}

		const session = await createTerminalSession(input.desktop, cwd)
		input.signals.session.set(session)
		input.setSubscription(
			subscribeTerminalStream(
				input.desktop,
				session.id,
				event => {
					if (event.type === 'data' && event.chunk) {
						input.signals.lines.update(lines => [...lines, event.chunk ?? ''])
					}
					if (event.type === 'line') {
						input.signals.lineCount.update(lineCount => lineCount + 1)
					}
					if (event.type === 'exit') {
						input.signals.lines.update(lines => [...lines, `\n[terminal exited: ${event.exitCode ?? 0}]`])
					}
				},
				error => {
					input.signals.error.set(error instanceof Error ? error.message : String(error))
				}
			)
		)
	}
})
