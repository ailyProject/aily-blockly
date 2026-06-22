import { littlefsWasmUrl, readFfsWasmBinary } from '../../wasm'
import createLittlefsModule from '../../wasm/littlefs/littlefs.js'
import { allocLittlefs, assertLittlefs } from './shared'

import type { LittlefsModule } from './shared'

/**
 * 初始化并挂载 LittleFS 模块。
 * @param options - 初始化参数
 */
export const initializeLittlefsModule = async (options: {
	image?: Uint8Array
	blockSize: number
	blockCount: number
	lookaheadSize?: number
}) => {
	const wasmBinary = await readFfsWasmBinary(littlefsWasmUrl)
	const module = (await createLittlefsModule({ wasmBinary })) as LittlefsModule
	const lookaheadSize = options.lookaheadSize ?? 32

	if (options.image) {
		const imagePtr = allocLittlefs(module, options.image.length)
		module.HEAPU8.set(options.image, imagePtr)
		try {
			assertLittlefs(
				module._lfs_wasm_init_from_image(
					imagePtr,
					options.image.length,
					options.blockSize,
					options.blockCount,
					lookaheadSize
				),
				'initialize LittleFS image'
			)
		} finally {
			module._free(imagePtr)
		}
	} else {
		assertLittlefs(module._lfs_wasm_init(options.blockSize, options.blockCount, lookaheadSize), 'initialize LittleFS')
		assertLittlefs(module._lfs_wasm_format(), 'format LittleFS')
	}

	assertLittlefs(module._lfs_wasm_mount(), 'mount LittleFS')
	return module
}

/**
 * 创建 LittleFS 镜像与容量相关操作。
 * @param module - LittleFS 模块实例
 * @param options - 初始化参数
 */
export const createLittlefsImageBindings = (
	module: LittlefsModule,
	options: { blockSize: number; blockCount: number }
) => ({
	format() {
		assertLittlefs(module._lfs_wasm_format(), 'format LittleFS')
		assertLittlefs(module._lfs_wasm_mount(), 'remount LittleFS')
		return Promise.resolve()
	},
	toImage() {
		const size = module._lfs_wasm_get_image_size()
		const ptr = module._lfs_wasm_get_image()
		return Promise.resolve(module.HEAPU8.slice(ptr, ptr + size))
	},
	getUsage() {
		const usedPtr = allocLittlefs(module, 4)
		const totalPtr = allocLittlefs(module, 4)
		try {
			const result = module._lfs_wasm_fs_stat(usedPtr, totalPtr)
			if (result !== 0) {
				return Promise.resolve({
					capacityBytes: options.blockSize * options.blockCount,
					usedBytes: 0,
					freeBytes: options.blockSize * options.blockCount
				})
			}
			const blocksUsed = module.HEAPU32[usedPtr >> 2]
			const blocksTotal = module.HEAPU32[totalPtr >> 2]
			const capacityBytes = blocksTotal * options.blockSize
			const usedBytes = blocksUsed * options.blockSize
			return Promise.resolve({ capacityBytes, usedBytes, freeBytes: Math.max(0, capacityBytes - usedBytes) })
		} finally {
			module._free(usedPtr)
			module._free(totalPtr)
		}
	}
})
