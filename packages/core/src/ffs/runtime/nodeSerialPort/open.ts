import { SerialPort } from 'serialport'

import { attachFfsNodeSerialPort } from './shared'

import type { FfsNodeSerialPortRuntimeState } from './shared'
import type { FfsNodeSerialOpenOptions } from './types'

/**
 * 打开底层串口并在运行时状态上挂接读写流。
 * @param input - 串口路径、额外参数和打开参数
 */
export const openFfsNodeSerialPort = async (input: {
	path: string
	extraOptions: Record<string, unknown>
	runtime: FfsNodeSerialPortRuntimeState
	options: FfsNodeSerialOpenOptions
}) => {
	if (input.runtime.port) throw new Error('串口已打开')

	const port = new SerialPort({
		...input.extraOptions,
		path: input.path,
		baudRate: input.options.baudRate ?? 115200,
		autoOpen: false,
		dataBits: input.options.dataBits,
		stopBits: input.options.stopBits,
		parity: input.options.parity,
		rtscts: input.options.flowControl === 'hardware'
	})

	await new Promise<void>((resolve, reject) => {
		port.open(error => (error ? reject(error) : resolve()))
	})

	input.runtime.port = port
	attachFfsNodeSerialPort(input.runtime, port)
}
