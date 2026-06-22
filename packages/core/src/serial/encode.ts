import type { SerialSendPayloadInput } from './types'

/**
 * 将字节数据格式化为十六进制文本。
 * @param bytes - 原始字节数据
 */
export const toSerialHex = (bytes: Uint8Array) =>
	Array.from(bytes)
		.map(byte => byte.toString(16).padStart(2, '0'))
		.join(' ')

/**
 * 将发送输入编码为实际字节数据。
 * @param options - 发送输入
 */
export const encodeSerialSendPayload = (options: SerialSendPayloadInput) => {
	if (options.mode === 'hex') {
		const hexString = options.data.replace(/[^0-9A-Fa-f]/g, '')
		const normalized = hexString.length % 2 === 0 ? hexString : `0${hexString}`
		return Buffer.from(normalized, 'hex')
	}

	let text = options.data
	if (options.endR) text += '\r'
	if (options.endN) text += '\n'
	return Buffer.from(text, 'utf8')
}
