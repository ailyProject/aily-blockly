import type { ESPLoader, Transport } from 'esptool-js'
import type { FfsEspChipInfo, FfsReadFlashProgress } from './types'

const FLASH_READ_MAX_CHUNK = 0x10000
const FLASH_READ_MIN_CHUNK = 0x1000

type EsptoolBundleModule = Pick<typeof import('esptool-js'), 'ESPLoader' | 'Transport'>

/**
 * 动态加载 `esptool-js` bundle。
 */
export const loadEsptoolBundle = () =>
	new Function('return import("esptool-js/bundle.js")')() as Promise<EsptoolBundleModule>

/**
 * 聚合当前 ESP 会话内部状态。
 */
export interface FfsEspSessionState {
	port: import('../nodeSerialPort').FfsNodeSerialPortAdapter | null
	transport: Transport | null
	loader: ESPLoader | null
	chipInfo: FfsEspChipInfo | null
	currentPortPath: string | null
	currentBaud: number
	currentRequestedBaud: number
	queue: Promise<unknown>
}

/**
 * 读取 flash，并按 chunk 汇总进度与结果。
 * @param loader - 当前 ESP loader
 * @param offset - 起始偏移
 * @param length - 目标长度
 * @param onProgress - 进度回调
 */
export const readFfsFlashChunks = async (
	loader: ESPLoader,
	offset: number,
	length: number,
	onProgress?: FfsReadFlashProgress
) => {
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
}
