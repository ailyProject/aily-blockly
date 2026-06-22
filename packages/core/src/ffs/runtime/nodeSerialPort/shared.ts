import type { SerialPort } from 'serialport'

/**
 * Node WebSerial 适配器内部可变状态。
 */
export interface FfsNodeSerialPortRuntimeState {
	port: SerialPort | null
	queue: Array<Uint8Array>
	pending: (() => void) | null
	closed: boolean
	streamError: Error | null
	currentReadable: ReadableStream<Uint8Array> | null
	writable: WritableStream<Uint8Array> | null
}

/**
 * 创建默认运行时状态。
 */
export const createFfsNodeSerialPortRuntimeState = (): FfsNodeSerialPortRuntimeState => ({
	port: null,
	queue: [],
	pending: null,
	closed: false,
	streamError: null,
	currentReadable: null,
	writable: null
})

/**
 * 在适配器状态上挂接底层串口事件与 writable 流。
 * @param state - 适配器运行时状态
 * @param port - 已打开的底层串口
 */
export const attachFfsNodeSerialPort = (state: FfsNodeSerialPortRuntimeState, port: SerialPort) => {
	state.queue = []
	state.closed = false
	state.streamError = null

	port.on('data', data => {
		state.queue.push(data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.buffer))
		state.pending?.()
		state.pending = null
	})

	port.on('close', () => {
		state.closed = true
		state.pending?.()
		state.pending = null
	})

	port.on('error', error => {
		state.streamError = error
		state.pending?.()
		state.pending = null
	})

	state.writable = new WritableStream<Uint8Array>({
		write: chunk =>
			new Promise<void>((resolve, reject) => {
				port.write(chunk, error => (error ? reject(error) : resolve()))
			})
	})
}

/**
 * 基于当前状态创建懒加载的 readable 流。
 * @param state - 适配器运行时状态
 */
export const createFfsNodeSerialReadable = (state: FfsNodeSerialPortRuntimeState) => {
	const stream = new ReadableStream<Uint8Array>({
		pull: async controller => {
			if (state.queue.length > 0) {
				controller.enqueue(state.queue.shift()!)
				return
			}

			if (state.streamError) {
				controller.error(state.streamError)
				state.streamError = null
				state.currentReadable = null
				return
			}

			if (state.closed) {
				controller.close()
				state.currentReadable = null
				return
			}

			await new Promise<void>(resolve => {
				state.pending = resolve
			})
		},
		cancel: () => {
			state.currentReadable = null
		}
	})

	state.currentReadable = stream
	return stream
}
