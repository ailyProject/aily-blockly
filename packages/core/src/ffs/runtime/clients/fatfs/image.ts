import { assertFatfsOk } from './shared'

import type { FfsTreeFilesystemClient } from '../../filesystem/types'

type FatfsRuntimeModule = {
	exports: {
		free(ptr: number): void
		fatfsjs_format(): number
		fatfsjs_export_image(ptr: number, size: number): number
		fatfsjs_storage_size(): number
	}
	memory: {
		heap: Uint8Array
		alloc(size: number): number
	}
}

/**
 * 创建 FATFS 镜像与容量绑定。
 * @param module - 已初始化的 FATFS 运行时模块
 */
export const createFatfsImageBindings = (
	module: FatfsRuntimeModule
): Pick<FfsTreeFilesystemClient, 'format' | 'toImage' | 'getUsage'> => ({
	format() {
		assertFatfsOk(module.exports.fatfsjs_format(), 'format FATFS')
		return Promise.resolve()
	},
	toImage() {
		const size = module.exports.fatfsjs_storage_size()
		const ptr = module.memory.alloc(size)
		try {
			assertFatfsOk(module.exports.fatfsjs_export_image(ptr, size), 'export FATFS image')
			return Promise.resolve(module.memory.heap.slice(ptr, ptr + size))
		} finally {
			if (ptr) module.exports.free(ptr)
		}
	},
	getUsage() {
		const capacityBytes = module.exports.fatfsjs_storage_size()
		return Promise.resolve({ capacityBytes, usedBytes: 0, freeBytes: capacityBytes })
	}
})
