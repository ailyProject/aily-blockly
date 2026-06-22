import type { SerialMonitorSignals } from './component.types'

/**
 * 聚合 Serial Monitor 页面使用的 signals。
 * @param input - 页面持有的各个 signal
 */
export const createSerialMonitorSignals = (input: SerialMonitorSignals): SerialMonitorSignals => ({
	state: input.state,
	messages: input.messages,
	inputValue: input.inputValue,
	runtimeInfo: input.runtimeInfo,
	uploadResult: input.uploadResult,
	loading: input.loading,
	busy: input.busy,
	error: input.error
})
