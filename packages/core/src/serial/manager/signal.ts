import { createSerialTimestamp, pushSerialMessage } from '../state'
import { readConnectedSerialSession } from './shared'

import type { SerialSignalInput, SerialSignalResult } from '../types'

/**
 * 切换串口控制信号。
 * @param input - 信号输入
 */
export const setSerialSessionSignal = async (input: SerialSignalInput): Promise<SerialSignalResult> => {
	const session = readConnectedSerialSession(input.port)
	const enabled = input.enabled ?? !session.signals[input.signal]
	await new Promise<void>((resolve, reject) => {
		session.port.set({ [input.signal]: enabled }, error => (error ? reject(error) : resolve()))
	})
	session.signals[input.signal] = enabled
	pushSerialMessage(session.messages, {
		direction: 'sys',
		timestamp: createSerialTimestamp(),
		text: `[serial signal ${input.signal.toUpperCase()}: ${enabled ? 'on' : 'off'}]`,
		hex: ''
	})

	return {
		success: true,
		signal: input.signal,
		enabled
	}
}
