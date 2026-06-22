import { allocSpiffs, allocSpiffsString, assertSpiffs, normalizeSpiffsPath, parseSpiffsEntries } from './shared'

import type { FfsSpiffsClient } from '../../filesystem/types'
import type { SpiffsRuntimeModule } from './init'

const textDecoder = new TextDecoder()

/**
 * 创建 SPIFFS 文件读写绑定。
 * @param module - 已初始化的 SPIFFS 运行时模块
 */
export const createSpiffsFileBindings = (
	module: SpiffsRuntimeModule
): Pick<FfsSpiffsClient, 'list' | 'read' | 'write' | 'remove'> => ({
	async list() {
		const ptr = allocSpiffs(module.exports, 4096)
		try {
			const used = module.exports.spiffsjs_list(ptr, 4096)
			assertSpiffs(used, 'list SPIFFS files')
			return parseSpiffsEntries(textDecoder.decode(module.heap.subarray(ptr, ptr + used)))
		} finally {
			module.exports.free(ptr)
		}
	},
	async read(path) {
		const normalizedPath = normalizeSpiffsPath(path)
		const pathPtr = allocSpiffsString(module.exports, module.heap, normalizedPath)
		let dataPtr = 0
		try {
			const size = module.exports.spiffsjs_file_size(pathPtr)
			assertSpiffs(size, `stat SPIFFS file "${path}"`)
			dataPtr = allocSpiffs(module.exports, size)
			const read = module.exports.spiffsjs_read_file(pathPtr, dataPtr, size)
			assertSpiffs(read, `read SPIFFS file "${path}"`)
			return module.heap.slice(dataPtr, dataPtr + read)
		} finally {
			if (dataPtr) module.exports.free(dataPtr)
			module.exports.free(pathPtr)
		}
	},
	async write(path, data) {
		const normalizedPath = normalizeSpiffsPath(path)
		const pathPtr = allocSpiffsString(module.exports, module.heap, normalizedPath)
		const dataPtr = allocSpiffs(module.exports, data.length)
		try {
			module.heap.set(data, dataPtr)
			assertSpiffs(module.exports.spiffsjs_write_file(pathPtr, dataPtr, data.length), `write SPIFFS file "${path}"`)
		} finally {
			if (dataPtr) module.exports.free(dataPtr)
			module.exports.free(pathPtr)
		}
	},
	async remove(path) {
		const normalizedPath = normalizeSpiffsPath(path)
		const pathPtr = allocSpiffsString(module.exports, module.heap, normalizedPath)
		try {
			assertSpiffs(module.exports.spiffsjs_remove_file(pathPtr), `delete SPIFFS file "${path}"`)
		} finally {
			module.exports.free(pathPtr)
		}
	}
})
