import { connectFfsEspSession, disconnectFfsEspSession } from './connect'
import { readFfsFlashChunks } from './shared'

import type { ESPLoader } from 'esptool-js'
import type { FfsEspSessionState } from './shared'
import type { FfsEspChipInfo, FfsEspSessionConnectOptions, FfsReadFlashProgress, FfsWriteFlashProgress } from './types'

/**
 * FFS 使用的 ESP 会话封装。
 */
export class FfsEspSession {
	private readonly state: FfsEspSessionState = {
		port: null,
		transport: null,
		loader: null,
		chipInfo: null,
		currentPortPath: null,
		currentBaud: 0,
		currentRequestedBaud: 0,
		queue: Promise.resolve()
	}

	get isConnected() {
		return Boolean(this.state.loader && this.state.transport)
	}

	get chip() {
		return this.state.chipInfo
	}

	get portPath() {
		return this.state.currentPortPath
	}

	get baudRate() {
		return this.state.currentBaud
	}

	/**
	 * 建立 ESP 会话并上传 stub。
	 * @param options - 会话连接参数
	 */
	async connect(options: FfsEspSessionConnectOptions): Promise<FfsEspChipInfo> {
		if (
			this.isConnected &&
			this.state.currentPortPath === options.portPath &&
			this.state.currentRequestedBaud === options.baudRate
		) {
			return this.state.chipInfo!
		}

		if (this.isConnected) await this.disconnect()
		return connectFfsEspSession(this.state, options)
	}

	/**
	 * 断开当前 ESP 会话。
	 */
	async disconnect(): Promise<void> {
		await disconnectFfsEspSession(this.state)
	}

	async readFlash(offset: number, length: number, onProgress?: FfsReadFlashProgress) {
		if (length <= 0) return new Uint8Array(0)
		return this.runExclusive(loader => readFfsFlashChunks(loader, offset, length, onProgress))
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
		const next = this.state.queue.then(async () => {
			if (!this.state.loader) throw new Error('ESP 设备未连接')
			return task(this.state.loader)
		})

		this.state.queue = next.then(
			() => undefined,
			() => undefined
		)

		return next
	}
}

export * from './types'
