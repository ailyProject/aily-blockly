import type { SerialPort } from 'serialport'
import type { SerialMonitorConnectOptions } from 'shared'
import type { SerialSessionMessage, SerialSessionSnapshot, SerialSignalKind } from './types'

/**
 * 串口运行时会话。
 */
export type SerialRuntimeSession = {
	/** 当前打开的串口实例。 */
	port: SerialPort
	/** 当前会话的连接参数。 */
	options: SerialMonitorConnectOptions
	/** 尚未被 UI 拉取的消息缓冲。 */
	messages: Array<SerialSessionMessage>
	/** 当前缓存的控制信号状态。 */
	signals: Record<SerialSignalKind, boolean>
}

const serialMessageLimit = 1000

export const serialSessions = new Map<string, SerialRuntimeSession>()

/**
 * 返回当前串口消息时间戳。
 */
export const createSerialTimestamp = () => new Date().toLocaleTimeString()

/**
 * 追加串口消息并维护缓冲上限。
 * @param messages - 当前消息缓冲
 * @param message - 新消息
 */
export const pushSerialMessage = (messages: Array<SerialSessionMessage>, message: SerialSessionMessage) => {
	messages.push(message)
	if (messages.length > serialMessageLimit) {
		messages.splice(0, messages.length - serialMessageLimit)
	}
}

/**
 * 将运行时会话转换为对外快照。
 * @param session - 当前运行时会话
 */
export const toSerialSessionSnapshot = (session: SerialRuntimeSession): SerialSessionSnapshot => ({
	port: session.options.path,
	connected: session.port.isOpen,
	options: session.options,
	bufferedMessages: session.messages.length
})
