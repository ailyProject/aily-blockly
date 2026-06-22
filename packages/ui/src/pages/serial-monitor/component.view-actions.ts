import type { Signal, WritableSignal } from '@angular/core'
import type { SerialMonitorPageState } from './types'

/**
 * 创建 Serial Monitor 的视图与轮询动作。
 * @param input - 页面状态与 UI 交互依赖
 */
export const createSerialMonitorViewActions = (input: {
	state: Signal<SerialMonitorPageState | null>
	inputValue: WritableSignal<string>
	getLogBox: () => HTMLDivElement | undefined
	pullMessages: (port: string) => Promise<void>
	patchInputMode: (patch: Partial<SerialMonitorPageState['inputMode']>) => void
	patchViewMode: (patch: Partial<SerialMonitorPageState['viewMode']>) => void
}) => {
	let pollTimer: ReturnType<typeof setInterval> | null = null

	const stopPolling = () => {
		if (!pollTimer) return
		clearInterval(pollTimer)
		pollTimer = null
	}

	const scrollToBottom = () => {
		requestAnimationFrame(() => {
			const element = input.getLogBox()
			if (element) element.scrollTop = element.scrollHeight
		})
	}

	return {
		toggleHexView() {
			input.patchViewMode({ showHex: !input.state()?.viewMode.showHex })
		},
		toggleTimestamp() {
			input.patchViewMode({ showTimestamp: !input.state()?.viewMode.showTimestamp })
		},
		toggleAutoScroll() {
			input.patchViewMode({ autoScroll: !input.state()?.viewMode.autoScroll })
		},
		toggleHexInput() {
			input.patchInputMode({ hexMode: !input.state()?.inputMode.hexMode })
		},
		toggleSendByEnter() {
			input.patchInputMode({ sendByEnter: !input.state()?.inputMode.sendByEnter })
		},
		toggleEndR() {
			input.patchInputMode({ endR: !input.state()?.inputMode.endR })
		},
		toggleEndN() {
			input.patchInputMode({ endN: !input.state()?.inputMode.endN })
		},
		updateInputValue(value: string) {
			input.inputValue.set(value)
		},
		startPolling(port: string) {
			stopPolling()
			pollTimer = setInterval(() => void input.pullMessages(port), 300)
		},
		stopPolling,
		scrollToBottom,
		dispose() {
			stopPolling()
		}
	}
}
