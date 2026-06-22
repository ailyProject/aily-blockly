import { parseFatfsEntries } from './entries'
import { assertFatfsOk, normalizeFatfsMountPath } from './shared'

import type { FfsTreeFilesystemClient } from '../../filesystem/types'

type FatfsRuntimeModule = {
	exports: {
		free(ptr: number): void
		fatfsjs_list(pathPtr: number, outPtr: number, capacity: number): number
		fatfsjs_file_size(pathPtr: number): number
		fatfsjs_read_file(pathPtr: number, outPtr: number, size: number): number
		fatfsjs_write_file(pathPtr: number, dataPtr: number, size: number): number
		fatfsjs_delete_file(pathPtr: number): number
		fatfsjs_mkdir(pathPtr: number): number
		fatfsjs_rename(fromPtr: number, toPtr: number): number
	}
	memory: {
		heap: Uint8Array
		alloc(size: number): number
		allocString(value: string): number
		decode(ptr: number, size: number): string
	}
}

/**
 * 创建 FATFS 文件读写绑定。
 * @param module - 已初始化的 FATFS 运行时模块
 */
export const createFatfsFileBindings = (
	module: FatfsRuntimeModule
): Pick<FfsTreeFilesystemClient, 'list' | 'readFile' | 'writeFile' | 'deleteFile' | 'mkdir' | 'rename'> => ({
	list(path = '/fatfs') {
		const normalizedPath = normalizeFatfsMountPath(path)
		const pathPtr = module.memory.allocString(normalizedPath)
		let outPtr = 0
		try {
			outPtr = module.memory.alloc(4096)
			const used = module.exports.fatfsjs_list(pathPtr, outPtr, 4096)
			assertFatfsOk(used, 'list FATFS files')
			const payload = module.memory.decode(outPtr, used)
			return parseFatfsEntries(payload, normalizedPath)
		} finally {
			if (outPtr) module.exports.free(outPtr)
			module.exports.free(pathPtr)
		}
	},
	readFile(path) {
		const pathPtr = module.memory.allocString(normalizeFatfsMountPath(path))
		let dataPtr = 0
		try {
			const size = module.exports.fatfsjs_file_size(pathPtr)
			assertFatfsOk(size, `stat FATFS file "${path}"`)
			dataPtr = module.memory.alloc(size)
			const read = module.exports.fatfsjs_read_file(pathPtr, dataPtr, size)
			assertFatfsOk(read, `read FATFS file "${path}"`)
			return module.memory.heap.slice(dataPtr, dataPtr + read)
		} finally {
			if (dataPtr) module.exports.free(dataPtr)
			module.exports.free(pathPtr)
		}
	},
	writeFile(path, data) {
		const pathPtr = module.memory.allocString(normalizeFatfsMountPath(path))
		const dataPtr = module.memory.alloc(data.length)
		try {
			module.memory.heap.set(data, dataPtr)
			assertFatfsOk(module.exports.fatfsjs_write_file(pathPtr, dataPtr, data.length), `write FATFS file "${path}"`)
		} finally {
			if (dataPtr) module.exports.free(dataPtr)
			module.exports.free(pathPtr)
		}
	},
	deleteFile(path) {
		const pathPtr = module.memory.allocString(normalizeFatfsMountPath(path))
		try {
			assertFatfsOk(module.exports.fatfsjs_delete_file(pathPtr), `delete FATFS file "${path}"`)
		} finally {
			module.exports.free(pathPtr)
		}
	},
	mkdir(path) {
		const pathPtr = module.memory.allocString(normalizeFatfsMountPath(path))
		try {
			assertFatfsOk(module.exports.fatfsjs_mkdir(pathPtr), `mkdir FATFS "${path}"`)
		} finally {
			module.exports.free(pathPtr)
		}
	},
	rename(fromPath, toPath) {
		const fromPtr = module.memory.allocString(normalizeFatfsMountPath(fromPath))
		const toPtr = module.memory.allocString(normalizeFatfsMountPath(toPath))
		try {
			assertFatfsOk(module.exports.fatfsjs_rename(fromPtr, toPtr), `rename FATFS "${fromPath}"`)
		} finally {
			module.exports.free(fromPtr)
			module.exports.free(toPtr)
		}
	}
})
