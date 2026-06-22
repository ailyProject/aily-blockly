import { closeFfsNodeSerialPort } from './close'
import { openFfsNodeSerialPort } from './open'
import { createFfsNodeSerialPortRuntimeState, createFfsNodeSerialReadable } from './shared'
import { setFfsNodeSerialPortSignals } from './signals'

import type { FfsNodeSerialOpenOptions, FfsNodeSerialPortAdapterOptions } from './types'

/**
 * Node `serialport` 到 WebSerial 形状的适配层。
 */
export class FfsNodeSerialPortAdapter {
	readonly path: string

	private readonly extraOptions: Record<string, unknown>
	private readonly runtime = createFfsNodeSerialPortRuntimeState()

	get readable(): ReadableStream<Uint8Array> | null {
		if (!this.runtime.port) return null
		return this.runtime.currentReadable ?? createFfsNodeSerialReadable(this.runtime)
	}

	get writable(): WritableStream<Uint8Array> | null {
		return this.runtime.writable
	}

	constructor(options: FfsNodeSerialPortAdapterOptions) {
		this.path = options.path
		this.extraOptions = options.extra ?? {}
	}

	/**
	 * 打开底层串口并暴露 WebSerial 风格的读写流。
	 * @param options - 打开参数
	 */
	async open(options: FfsNodeSerialOpenOptions): Promise<void> {
		await openFfsNodeSerialPort({
			path: this.path,
			extraOptions: this.extraOptions,
			runtime: this.runtime,
			options
		})
	}

	/**
	 * 关闭底层串口。
	 */
	async close(): Promise<void> {
		await closeFfsNodeSerialPort(this.runtime)
	}

	/**
	 * 彻底释放适配器资源。
	 */
	async dispose(): Promise<void> {
		await this.close()
	}

	/**
	 * 设置 DTR/RTS 等线路信号。
	 * @param signals - 线路信号
	 */
	async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void> {
		await setFfsNodeSerialPortSignals(this.runtime, signals)
	}

	getInfo(): { usbVendorId?: number; usbProductId?: number } {
		return {}
	}
}

export * from './types'
