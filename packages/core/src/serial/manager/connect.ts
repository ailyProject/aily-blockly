import { SerialPort } from 'serialport'

import { serialSessions, toSerialSessionSnapshot } from '../state'
import { bindSerialRuntimeSession, createRuntimeSerialSession } from './shared'

import type { SerialMonitorConnectOptions } from 'shared'
import type { SerialSessionSnapshot } from '../types'

/**
 * 建立串口会话。
 * @param options - 串口连接参数
 */
export const connectSerialSession = async (options: SerialMonitorConnectOptions): Promise<SerialSessionSnapshot> => {
	const existing = serialSessions.get(options.path)
	if (existing?.port.isOpen) return toSerialSessionSnapshot(existing)

	const port = new SerialPort({
		path: options.path,
		baudRate: options.baudRate,
		dataBits: options.dataBits,
		stopBits: options.stopBits,
		parity: options.parity,
		autoOpen: false,
		rtscts: options.flowControl === 'hardware'
	})
	const session = createRuntimeSerialSession(port, options)
	bindSerialRuntimeSession(session)
	await new Promise<void>((resolve, reject) => {
		port.open(error => (error ? reject(error) : resolve()))
	})

	const { createSerialTimestamp, pushSerialMessage } = await import('../state')
	pushSerialMessage(session.messages, {
		direction: 'sys',
		timestamp: createSerialTimestamp(),
		text: `[serial connected: ${options.path}]`,
		hex: ''
	})
	serialSessions.set(options.path, session)
	return toSerialSessionSnapshot(session)
}

/**
 * 断开串口会话。
 * @param portPath - 串口路径
 */
export const disconnectSerialSession = async (portPath: string) => {
	const session = serialSessions.get(portPath)
	if (!session) return false

	await new Promise<void>(resolve => {
		if (!session.port.isOpen) return resolve()
		session.port.close(() => resolve())
	})
	serialSessions.delete(portPath)
	return true
}
