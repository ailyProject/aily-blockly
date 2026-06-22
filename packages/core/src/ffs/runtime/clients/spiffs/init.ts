import { spiffsWasmUrl } from '../../wasm'
import { instantiateFfsWasmModule } from '../shared'
import { allocSpiffs, assertSpiffs } from './shared'

import type { SpiffsExports } from './shared'

export type SpiffsRuntimeModule = {
	exports: SpiffsExports
	heap: Uint8Array
}

/**
 * 初始化 SPIFFS Wasm 模块。
 * @param options - SPIFFS 初始化参数
 */
export const initializeSpiffsModule = async (options: {
	image?: Uint8Array
	pageSize: number
	blockSize: number
	blockCount: number
	fdCount?: number
	cachePages?: number
}) => {
	const exports = (await instantiateFfsWasmModule(spiffsWasmUrl)) as SpiffsExports
	const heap = new Uint8Array(exports.memory.buffer)
	const fdCount = options.fdCount ?? 16
	const cachePages = options.cachePages ?? 64

	if (options.image) {
		const ptr = allocSpiffs(exports, options.image.length || 1)
		heap.set(options.image, ptr)
		try {
			assertSpiffs(
				exports.spiffsjs_init_from_image(
					options.pageSize,
					options.blockSize,
					options.blockCount,
					fdCount,
					cachePages,
					ptr,
					options.image.length
				),
				'initialize SPIFFS image'
			)
		} finally {
			exports.free(ptr)
		}
	} else {
		assertSpiffs(
			exports.spiffsjs_init(options.pageSize, options.blockSize, options.blockCount, fdCount, cachePages),
			'initialize SPIFFS'
		)
		assertSpiffs(exports.spiffsjs_format(), 'format SPIFFS')
	}

	return {
		exports,
		heap
	} satisfies SpiffsRuntimeModule
}
