import { SerialPort } from 'serialport'

import type { FfsNodeSerialOpenOptions, FfsNodeSerialPortAdapterOptions } from './nodeSerialPort.types'

/**
 * Node `serialport` 到 WebSerial 形状的适配层。
 */
export class FfsNodeSerialPortAdapter {
	readonly path: string

	private readonly extraOptions: Record<string, unknown>
	private port: SerialPort | null = null
	private queue: Array<Uint8Array> = []
	private pending: (() => void) | null = null
	private closed = false
	private streamError: Error | null = null
	private currentReadable: ReadableStream<Uint8Array> | null = null

	writable: WritableStream<Uint8Array> | null = null

	get readable(): ReadableStream<Uint8Array> | null {
		if (!this.port) return null
		return this.currentReadable ?? this.createReadable()
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
		if (this.port) throw new Error('串口已打开')

		const port = new SerialPort({
			...this.extraOptions,
			path: this.path,
			baudRate: options.baudRate ?? 115200,
			autoOpen: false,
			dataBits: options.dataBits,
			stopBits: options.stopBits,
			parity: options.parity,
			rtscts: options.flowControl === 'hardware'
		})

		await new Promise<void>((resolve, reject) => {
			port.open(error => (error ? reject(error) : resolve()))
		})

		this.port = port
		this.attach(port)
	}

	/**
	 * 关闭底层串口。
	 */
	async close(): Promise<void> {
		const port = this.port
		if (!port) return

		this.port = null
		this.currentReadable = null
		this.writable = null
		this.closed = true
		this.queue = []
		this.pending?.()
		this.pending = null

		await new Promise<void>(resolve => {
			if (!port.isOpen) return resolve()
			port.close(() => resolve())
		})
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
		const port = this.port
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

	getInfo(): { usbVendorId?: number; usbProductId?: number } {
		return {}
	}

	private attach(port: SerialPort) {
		this.queue = []
		this.closed = false
		this.streamError = null

		port.on('data', data => {
			this.queue.push(data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.buffer))
			this.pending?.()
			this.pending = null
		})

		port.on('close', () => {
			this.closed = true
			this.pending?.()
			this.pending = null
		})

		port.on('error', error => {
			this.streamError = error
			this.pending?.()
			this.pending = null
		})

		this.writable = new WritableStream<Uint8Array>({
			write: chunk =>
				new Promise<void>((resolve, reject) => {
					port.write(chunk, error => (error ? reject(error) : resolve()))
				})
		})
	}

	private createReadable() {
		const stream = new ReadableStream<Uint8Array>({
			pull: async controller => {
				if (this.queue.length > 0) {
					controller.enqueue(this.queue.shift()!)
					return
				}

				if (this.streamError) {
					controller.error(this.streamError)
					this.streamError = null
					this.currentReadable = null
					return
				}

				if (this.closed) {
					controller.close()
					this.currentReadable = null
					return
				}

				await new Promise<void>(resolve => {
					this.pending = resolve
				})
			},
			cancel: () => {
				this.currentReadable = null
			}
		})

		this.currentReadable = stream
		return stream
	}
}
