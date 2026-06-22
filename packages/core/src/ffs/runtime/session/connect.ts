import { resolveFfsBaudrate } from '../bridge'
import { FfsNodeSerialPortAdapter } from '../nodeSerialPort'
import { loadEsptoolBundle } from './shared'

import type { FfsEspSessionState } from './shared'
import type { FfsEspSessionConnectOptions } from './types'

/**
 * 建立 ESP 会话并初始化 loader。
 * @param state - 当前会话状态容器
 * @param options - 会话连接参数
 */
export const connectFfsEspSession = async (state: FfsEspSessionState, options: FfsEspSessionConnectOptions) => {
	const port = new FfsNodeSerialPortAdapter({ path: options.portPath })
	const resolved = await resolveFfsBaudrate(options.portPath, options.baudRate)
	if (resolved.capped) options.onBaudResolved?.(resolved, options.portPath)

	await port.open({ baudRate: resolved.baud })

	const { ESPLoader, Transport } = await loadEsptoolBundle()
	const transport = new Transport(port as never, false)
	const loader = new ESPLoader({
		transport,
		baudrate: resolved.baud,
		debugLogging: false,
		terminal: {
			clean: () => undefined,
			write: (text: string) => options.onLog?.(text),
			writeLine: (text: string) => options.onLog?.(text)
		}
	})

	try {
		const chipName = await loader.main('default_reset')
		state.port = port
		state.transport = transport
		state.loader = loader
		state.currentPortPath = options.portPath
		state.currentBaud = resolved.baud
		state.currentRequestedBaud = options.baudRate
		state.chipInfo = { chipName }
		return state.chipInfo
	} catch (error) {
		await transport.disconnect().catch(() => undefined)
		await port.dispose().catch(() => undefined)
		throw error
	}
}

/**
 * 断开当前 ESP 会话并重置状态。
 * @param state - 当前会话状态容器
 */
export const disconnectFfsEspSession = async (state: FfsEspSessionState): Promise<void> => {
	const port = state.port
	const transport = state.transport

	state.loader = null
	state.transport = null
	state.port = null
	state.chipInfo = null
	state.currentPortPath = null
	state.currentBaud = 0
	state.currentRequestedBaud = 0
	state.queue = Promise.resolve()

	await transport?.disconnect().catch(() => undefined)
	await port?.dispose().catch(() => undefined)
}
