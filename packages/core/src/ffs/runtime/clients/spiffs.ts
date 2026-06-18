import { spiffsWasmUrl } from '../wasm'
import { instantiateFfsWasmModule } from './shared'
import { allocSpiffs, allocSpiffsString, assertSpiffs, normalizeSpiffsPath, parseSpiffsEntries } from './spiffs.shared'

import type { FfsSpiffsClient } from '../filesystem.types'
import type { SpiffsExports } from './spiffs.shared'

const textDecoder = new TextDecoder()

/**
 * 创建 SPIFFS 客户端。
 * @param options - 初始化参数
 */
export const createSpiffsClient = async (options: {
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
		async list() {
			const ptr = allocSpiffs(exports, 4096)
			try {
				const used = exports.spiffsjs_list(ptr, 4096)
				assertSpiffs(used, 'list SPIFFS files')
				return parseSpiffsEntries(textDecoder.decode(heap.subarray(ptr, ptr + used)))
			} finally {
				exports.free(ptr)
			}
		},
		async read(path) {
			const normalizedPath = normalizeSpiffsPath(path)
			const pathPtr = allocSpiffsString(exports, heap, normalizedPath)
			let dataPtr = 0
			try {
				const size = exports.spiffsjs_file_size(pathPtr)
				assertSpiffs(size, `stat SPIFFS file "${path}"`)
				dataPtr = allocSpiffs(exports, size)
				const read = exports.spiffsjs_read_file(pathPtr, dataPtr, size)
				assertSpiffs(read, `read SPIFFS file "${path}"`)
				return heap.slice(dataPtr, dataPtr + read)
			} finally {
				if (dataPtr) exports.free(dataPtr)
				exports.free(pathPtr)
			}
		},
		async write(path, data) {
			const normalizedPath = normalizeSpiffsPath(path)
			const pathPtr = allocSpiffsString(exports, heap, normalizedPath)
			const dataPtr = allocSpiffs(exports, data.length)
			try {
				heap.set(data, dataPtr)
				assertSpiffs(exports.spiffsjs_write_file(pathPtr, dataPtr, data.length), `write SPIFFS file "${path}"`)
			} finally {
				if (dataPtr) exports.free(dataPtr)
				exports.free(pathPtr)
			}
		},
		async remove(path) {
			const normalizedPath = normalizeSpiffsPath(path)
			const pathPtr = allocSpiffsString(exports, heap, normalizedPath)
			try {
				assertSpiffs(exports.spiffsjs_remove_file(pathPtr), `delete SPIFFS file "${path}"`)
			} finally {
				exports.free(pathPtr)
			}
		},
		async format() {
			assertSpiffs(exports.spiffsjs_format(), 'format SPIFFS')
		},
		async toImage() {
			const size = exports.spiffsjs_storage_size()
			const ptr = allocSpiffs(exports, size)
			try {
				assertSpiffs(exports.spiffsjs_export_image(ptr, size), 'export SPIFFS image')
				return heap.slice(ptr, ptr + size)
			} finally {
				if (ptr) exports.free(ptr)
			}
		},
		async getUsage() {
			const ptr = allocSpiffs(exports, 12)
			try {
				assertSpiffs(exports.spiffsjs_get_usage(ptr), 'get SPIFFS usage')
				const view = new DataView(heap.buffer, ptr, 12)
				return {
					capacityBytes: view.getUint32(0, true),
					usedBytes: view.getUint32(4, true),
					freeBytes: view.getUint32(8, true)
				}
			} finally {
				exports.free(ptr)
			}
		}
	} satisfies FfsSpiffsClient
}
