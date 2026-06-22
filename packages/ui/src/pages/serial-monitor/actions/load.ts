import { loadSerialMonitorPageState } from '../runtime'

import type { Core } from '@/utils/core'
import type { Desktop, LoadDesktopHostRuntimeInfo } from '@/utils/desktop'
import type { SerialMonitorSignals } from '../component.types'

/**
 * 创建 Serial Monitor 载入动作。
 * @param input - 页面信号、core/desktop 依赖与轮询控制
 */
export const createSerialMonitorLoadActions = (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	signals: SerialMonitorSignals
	loadDesktopHostRuntimeInfo: LoadDesktopHostRuntimeInfo
	startPolling: (port: string) => void
	stopPolling: () => void
	pullMessages: (port: string) => Promise<void>
}) => ({
	async loadRuntimeInfo() {
		if (!input.desktop) return

		try {
			input.signals.runtimeInfo.set(await input.loadDesktopHostRuntimeInfo(input.desktop))
		} catch {
			input.signals.runtimeInfo.set(null)
		}
	},
	async refresh() {
		input.signals.loading.set(true)
		input.signals.error.set(null)
		input.stopPolling()
		try {
			const state = await loadSerialMonitorPageState(input.core, { runtimeInfo: input.signals.runtimeInfo() })
			input.signals.state.set(state)
			input.signals.messages.set([])
			if (state.session?.connected) {
				input.startPolling(state.session.port)
				await input.pullMessages(state.session.port)
			}
		} catch (error) {
			input.signals.error.set((error as Error).message)
		} finally {
			input.signals.loading.set(false)
		}
	}
})
