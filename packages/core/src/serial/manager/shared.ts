import { SerialPort } from 'serialport'

import { toSerialHex } from '../encode'
import { createSerialTimestamp, pushSerialMessage, serialSessions, toSerialSessionSnapshot } from '../state'

import type { SerialMonitorConnectOptions } from 'shared'
import type { SerialRuntimeSession } from '../state'
import type { SerialSessionSnapshot } from '../types'

/**
 * 创建新的串口运行时会话。
 * @param port - 当前串口实例
 * @param options - 当前连接参数
 */
export const createRuntimeSerialSession = (
	port: SerialPort,
	options: SerialMonitorConnectOptions
): SerialRuntimeSession => ({
	port,
	options,
	messages: [],
	signals: {
		dtr: false,
		rts: false
	}
})

/**
 * 读取当前已连接的串口会话。
 * @param portPath - 串口路径
 */
export const readConnectedSerialSession = (portPath: string) => {
	const session = serialSessions.get(portPath)
	if (!session?.port.isOpen) throw new Error(`Serial port is not connected: ${portPath}`)
	return session
}

/**
 * 给运行时会话挂接 data/error/close 监听。
 * @param session - 运行时会话
 */
export const bindSerialRuntimeSession = (session: SerialRuntimeSession) => {
	session.port.on('data', chunk => {
		const bytes =
			chunk instanceof Uint8Array
				? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
				: new Uint8Array(chunk)
		pushSerialMessage(session.messages, {
			direction: 'rx',
			timestamp: createSerialTimestamp(),
			text: Buffer.from(bytes).toString('utf8'),
			hex: toSerialHex(bytes)
		})
	})
	session.port.on('error', error => {
		pushSerialMessage(session.messages, {
			direction: 'sys',
			timestamp: createSerialTimestamp(),
			text: `[serial error: ${error.message}]`,
			hex: ''
		})
	})
	session.port.on('close', () => {
		pushSerialMessage(session.messages, {
			direction: 'sys',
			timestamp: createSerialTimestamp(),
			text: `[serial disconnected: ${session.options.path}]`,
			hex: ''
		})
	})
}

/**
 * 将当前串口路径映射成会话快照。
 * @param portPath - 串口路径
 */
export const getSerialSessionSnapshot = (portPath: string): SerialSessionSnapshot | null => {
	const session = serialSessions.get(portPath)
	return session ? toSerialSessionSnapshot(session) : null
}
