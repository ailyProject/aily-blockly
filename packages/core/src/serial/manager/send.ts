import { encodeSerialSendPayload, toSerialHex } from '../encode'
import { createSerialTimestamp, pushSerialMessage } from '../state'
import { readConnectedSerialSession } from './shared'

import type { SerialSendInput, SerialSendResult } from '../types'

/**
 * 发送串口数据。
 * @param input - 发送输入
 */
export const sendSerialSessionData = async (input: SerialSendInput): Promise<SerialSendResult> => {
	const session = readConnectedSerialSession(input.port)
	const payload = encodeSerialSendPayload(input)
	await new Promise<void>((resolve, reject) => {
		session.port.write(payload, error => (error ? reject(error) : resolve()))
	})
	pushSerialMessage(session.messages, {
		direction: 'tx',
		timestamp: createSerialTimestamp(),
		text: payload.toString('utf8'),
		hex: toSerialHex(payload)
	})

	return {
		success: true,
		bytes: payload.length
	}
}
