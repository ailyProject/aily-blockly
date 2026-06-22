import {
	connectSerialMonitor,
	disconnectSerialMonitor,
	drainSerialMonitorMessages,
	reconnectSerialMonitor,
	runSerialQuickSend,
	sendSerialMonitorInput,
	updateSerialMonitorConfig
} from '../runtime'

import type { Core } from '@/utils/core'
import type { QuickSendItem } from 'shared'
import type { SerialMonitorSignals } from '../component.types'
import type { SerialMonitorConfigPatch, SerialMonitorPageState } from '../types'

/**
 * 创建 Serial Monitor 会话动作。
 * @param input - 页面信号、core 依赖与轮询/滚动控制
 */
export const createSerialMonitorSessionActions = (input: {
	core: Core
	signals: SerialMonitorSignals
	startPolling: (port: string) => void
	stopPolling: () => void
	scrollToBottom: () => void
}) => ({
	async toggleConnection() {
		const current = input.signals.state()
		if (!current?.connectOptions.path) return input.signals.error.set('Please choose a serial port first.')
		input.signals.busy.set(true)
		input.signals.error.set(null)
		try {
			if (current.session?.connected) {
				await disconnectSerialMonitor(input.core, current.session.port)
				input.stopPolling()
				input.signals.state.update(state => (state ? { ...state, session: null } : state))
				return
			}
			const session = await connectSerialMonitor(input.core, current)
			input.signals.state.update(state => (state ? { ...state, session } : state))
			input.startPolling(session.port)
			await this.pullMessages(session.port)
		} catch (error) {
			input.signals.error.set((error as Error).message)
		} finally {
			input.signals.busy.set(false)
		}
	},
	async disconnectCurrent() {
		input.stopPolling()
		const port = input.signals.state()?.session?.port
		if (port) await disconnectSerialMonitor(input.core, port)
	},
	async choosePort(port: string) {
		await this.updateConfig({ port })
	},
	async chooseBaudRate(baudRate: string) {
		await this.updateConfig({ baudRate })
	},
	clearMessages() {
		input.signals.messages.set([])
	},
	patchInputMode(patch: Partial<SerialMonitorPageState['inputMode']>) {
		input.signals.state.update(state => (state ? { ...state, inputMode: { ...state.inputMode, ...patch } } : state))
	},
	patchViewMode(patch: Partial<SerialMonitorPageState['viewMode']>) {
		input.signals.state.update(state => (state ? { ...state, viewMode: { ...state.viewMode, ...patch } } : state))
	},
	updateInputValue(inputValue: string) {
		input.signals.inputValue.set(inputValue)
	},
	async send() {
		const current = input.signals.state()
		const inputValue = input.signals.inputValue().trim()
		if (!current?.session?.connected || !inputValue) return
		input.signals.busy.set(true)
		try {
			await sendSerialMonitorInput(input.core, current, inputValue)
			input.signals.inputValue.set('')
			await this.pullMessages(current.session.port)
		} finally {
			input.signals.busy.set(false)
		}
	},
	async sendQuick(item: QuickSendItem) {
		const current = input.signals.state()
		if (!current?.session?.connected) return
		input.signals.busy.set(true)
		try {
			await runSerialQuickSend(input.core, current, item)
			await this.pullMessages(current.session.port)
		} finally {
			input.signals.busy.set(false)
		}
	},
	async onInputKeydown(event: KeyboardEvent) {
		const current = input.signals.state()
		if (!current?.inputMode.sendByEnter || event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey)
			return
		event.preventDefault()
		await this.send()
	},
	async reconnect() {
		const current = input.signals.state()
		if (!current?.connectOptions.path) return
		input.signals.busy.set(true)
		input.signals.error.set(null)
		try {
			const session = await reconnectSerialMonitor(input.core, current)
			input.signals.state.update(state => (state ? { ...state, session } : state))
			input.signals.messages.set([])
			input.startPolling(session.port)
			await this.pullMessages(session.port)
		} catch (error) {
			input.signals.error.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.signals.busy.set(false)
		}
	},
	async updateConfig(patch: SerialMonitorConfigPatch) {
		const current = input.signals.state()
		if (!current || current.session?.connected) return
		input.signals.state.set(
			await updateSerialMonitorConfig(input.core, current, patch, { runtimeInfo: input.signals.runtimeInfo() })
		)
	},
	async pullMessages(port: string) {
		const drained = await drainSerialMonitorMessages(input.core, port)
		if (drained.length === 0) return
		input.signals.messages.update(messages => [...messages, ...drained])
		if (input.signals.state()?.viewMode.autoScroll) input.scrollToBottom()
	}
})
