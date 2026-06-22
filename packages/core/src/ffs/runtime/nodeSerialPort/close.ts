import type { FfsNodeSerialPortRuntimeState } from './shared'

/**
 * 关闭底层串口并重置运行时状态。
 * @param runtime - 串口运行时状态
 */
export const closeFfsNodeSerialPort = async (runtime: FfsNodeSerialPortRuntimeState) => {
	const port = runtime.port
	if (!port) return

	runtime.port = null
	runtime.currentReadable = null
	runtime.writable = null
	runtime.closed = true
	runtime.queue = []
	runtime.pending?.()
	runtime.pending = null

	await new Promise<void>(resolve => {
		if (!port.isOpen) return resolve()
		port.close(() => resolve())
	})
}
