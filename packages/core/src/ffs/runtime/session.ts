import { resolveFfsBaudrate } from './bridge'
import { FfsNodeSerialPortAdapter } from './nodeSerialPort'

import type { ESPLoader, Transport } from 'esptool-js'
import type {
	FfsEspChipInfo,
	FfsEspSessionConnectOptions,
	FfsReadFlashProgress,
	FfsWriteFlashProgress
} from './session.types'

const FLASH_READ_MAX_CHUNK = 0x10000
const FLASH_READ_MIN_CHUNK = 0x1000

type EsptoolBundleModule = Pick<typeof import('esptool-js'), 'ESPLoader' | 'Transport'>

const loadEsptoolBundle = () => new Function('return import("esptool-js/bundle.js")')() as Promise<EsptoolBundleModule>

/**
 * FFS 使用的 ESP 会话封装。
 */
export class FfsEspSession {
	private port: FfsNodeSerialPortAdapter | null = null
	private transport: Transport | null = null
	private loader: ESPLoader | null = null
	private chipInfo: FfsEspChipInfo | null = null
	private currentPortPath: string | null = null
	private currentBaud = 0
	private currentRequestedBaud = 0
	private queue: Promise<unknown> = Promise.resolve()

	get isConnected() {
		return Boolean(this.loader && this.transport)
	}

	get chip() {
		return this.chipInfo
	}

	get portPath() {
		return this.currentPortPath
	}

	get baudRate() {
		return this.currentBaud
	}

	/**
	 * 建立 ESP 会话并上传 stub。
	 * @param options - 会话连接参数
	 */
	async connect(options: FfsEspSessionConnectOptions): Promise<FfsEspChipInfo> {
		if (
			this.isConnected &&
			this.currentPortPath === options.portPath &&
			this.currentRequestedBaud === options.baudRate
		) {
			return this.chipInfo!
		}

		if (this.isConnected) await this.disconnect()

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
			this.port = port
			this.transport = transport
			this.loader = loader
			this.currentPortPath = options.portPath
			this.currentBaud = resolved.baud
			this.currentRequestedBaud = options.baudRate
			this.chipInfo = { chipName }
			return this.chipInfo
		} catch (error) {
			await transport.disconnect().catch(() => undefined)
			await port.dispose().catch(() => undefined)
			throw error
		}
	}

	/**
	 * 断开当前 ESP 会话。
	 */
	async disconnect(): Promise<void> {
		const port = this.port
		const transport = this.transport

		this.loader = null
		this.transport = null
		this.port = null
		this.chipInfo = null
		this.currentPortPath = null
		this.currentBaud = 0
		this.currentRequestedBaud = 0
		this.queue = Promise.resolve()

		await transport?.disconnect().catch(() => undefined)
		await port?.dispose().catch(() => undefined)
	}

	async readFlash(offset: number, length: number, onProgress?: FfsReadFlashProgress) {
		if (length <= 0) return new Uint8Array(0)

		return this.runExclusive(async loader => {
			const chunkSize = Math.max(FLASH_READ_MIN_CHUNK, Math.min(FLASH_READ_MAX_CHUNK, length))
			const buffers: Array<Uint8Array> = []
			let received = 0

			while (received < length) {
				const currentChunkSize = Math.min(chunkSize, length - received)
				const chunkBase = received
				const chunk = await loader.readFlash(
					offset + received,
					currentChunkSize,
					(_packet: unknown, packetReceived: number) => {
						onProgress?.(chunkBase + Math.min(packetReceived, currentChunkSize), length)
					}
				)

				buffers.push(chunk)
				received += chunk.length
			}

			const output = new Uint8Array(received)
			let cursor = 0
			for (const chunk of buffers) {
				output.set(chunk, cursor)
				cursor += chunk.length
			}
			return output
		})
	}

	async writePartitionImage(offset: number, data: Uint8Array, onProgress?: FfsWriteFlashProgress) {
		await this.runExclusive(loader =>
			loader.writeFlash({
				fileArray: [{ data, address: offset }],
				flashSize: 'keep',
				flashMode: 'keep',
				flashFreq: 'keep',
				eraseAll: false,
				compress: true,
				reportProgress: (_index: number, written: number, total: number) => onProgress?.(written, total)
			})
		)
	}

	private runExclusive<T>(task: (loader: ESPLoader) => Promise<T>) {
		const next = this.queue.then(async () => {
			if (!this.loader) throw new Error('ESP 设备未连接')
			return task(this.loader)
		})

		this.queue = next.then(
			() => undefined,
			() => undefined
		)

		return next
	}
}
