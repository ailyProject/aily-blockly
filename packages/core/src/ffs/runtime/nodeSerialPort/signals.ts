import type { FfsNodeSerialPortRuntimeState } from './shared'

/**
 * 设置 DTR/RTS 等线路信号。
 * @param runtime - 串口运行时状态
 * @param signals - 线路信号
 */
export const setFfsNodeSerialPortSignals = async (
	runtime: FfsNodeSerialPortRuntimeState,
	signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }
): Promise<void> => {
	const port = runtime.port
	if (!port) throw new Error('串口未打开')

	await new Promise<void>((resolve, reject) => {
		port.set(
			{
				dtr: signals.dataTerminalReady,
				rts: signals.requestToSend,
				brk: signals.break
			},
			error => (error ? reject(error) : resolve())
		)
	})
}
