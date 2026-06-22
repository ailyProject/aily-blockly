import type { Core } from '@/utils/core'
import type { SerialSessionMessage, SerialSessionSnapshot, SerialSignalKind } from '@core'
import type { QuickSendItem } from 'shared'
import type { SerialMonitorPageState } from '../types'

/**
 * 建立串口会话。
 * @param core - core 服务句柄
 * @param state - 当前页面状态
 */
export const connectSerialMonitor = (core: Core, state: SerialMonitorPageState): Promise<SerialSessionSnapshot> =>
	core.serial.connect.query(state.connectOptions)

/**
 * 断开串口会话。
 * @param core - core 服务句柄
 * @param port - 当前端口
 */
export const disconnectSerialMonitor = (core: Core, port: string) => core.serial.disconnect.query({ port })

/**
 * 重新建立当前串口连接。
 * @param core - core 服务句柄
 * @param state - 当前页面状态
 */
export const reconnectSerialMonitor = async (
	core: Core,
	state: SerialMonitorPageState
): Promise<SerialSessionSnapshot> => {
	if (state.session?.connected) {
		await disconnectSerialMonitor(core, state.session.port)
	}

	return connectSerialMonitor(core, state)
}

/**
 * 拉取并清空串口日志缓冲。
 * @param core - core 服务句柄
 * @param port - 当前端口
 */
export const drainSerialMonitorMessages = (core: Core, port: string): Promise<Array<SerialSessionMessage>> =>
	core.serial.drain.query({ port })

/**
 * 发送输入框中的串口数据。
 * @param core - core 服务句柄
 * @param state - 当前页面状态
 * @param inputValue - 输入框内容
 */
export const sendSerialMonitorInput = (core: Core, state: SerialMonitorPageState, inputValue: string) =>
	core.serial.send.query({
		port: state.connectOptions.path,
		data: inputValue,
		mode: state.inputMode.hexMode ? 'hex' : 'text',
		endR: state.inputMode.endR,
		endN: state.inputMode.endN
	})

const resolveSignalKind = (data: string): SerialSignalKind => (data.trim().toLowerCase() === 'rts' ? 'rts' : 'dtr')

/**
 * 执行快捷发送动作。
 * @param core - core 服务句柄
 * @param state - 当前页面状态
 * @param item - 当前快捷发送项
 */
export const runSerialQuickSend = async (core: Core, state: SerialMonitorPageState, item: QuickSendItem) => {
	if (item.type === 'signal') {
		return core.serial.signal.query({
			port: state.connectOptions.path,
			signal: resolveSignalKind(item.data)
		})
	}

	return core.serial.send.query({
		port: state.connectOptions.path,
		data: item.data,
		mode: item.type === 'hex' ? 'hex' : 'text',
		endR: state.inputMode.endR,
		endN: state.inputMode.endN
	})
}
