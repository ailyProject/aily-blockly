import { fatfsWasmUrl } from '../wasm'
import { instantiateFfsWasmModule } from './shared'

import type { FfsTreeFilesystemClient } from '../filesystem.types'

type FatfsExports = WebAssembly.Exports & {
	memory: WebAssembly.Memory
	malloc(size: number): number
	free(ptr: number): void
	fatfsjs_init(blockSize: number, blockCount: number): number
	fatfsjs_init_from_image(ptr: number, size: number): number
	fatfsjs_format(): number
	fatfsjs_list(pathPtr: number, outPtr: number, capacity: number): number
	fatfsjs_file_size(pathPtr: number): number
	fatfsjs_read_file(pathPtr: number, outPtr: number, size: number): number
	fatfsjs_export_image(ptr: number, size: number): number
	fatfsjs_storage_size(): number
	fatfsjs_write_file(pathPtr: number, dataPtr: number, size: number): number
	fatfsjs_delete_file(pathPtr: number): number
	fatfsjs_mkdir(pathPtr: number): number
	fatfsjs_rename(fromPtr: number, toPtr: number): number
}

const FAT_MOUNT = '/fatfs'
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * 创建 FatFS 客户端。
 * @param options - 初始化参数
 */
export const createFatfsClient = async (options: { image?: Uint8Array; blockSize: number; blockCount: number }) => {
	const exports = (await instantiateFfsWasmModule(fatfsWasmUrl)) as FatfsExports
	const heap = new Uint8Array(exports.memory.buffer)

	if (options.image) {
		const imagePtr = exports.malloc(options.image.length || 1)
		heap.set(options.image, imagePtr)
		try {
			assertOk(exports.fatfsjs_init_from_image(imagePtr, options.image.length), 'initialize FATFS image')
		} finally {
			exports.free(imagePtr)
		}
	} else {
		assertOk(exports.fatfsjs_init(options.blockSize, options.blockCount), 'initialize FATFS')
		assertOk(exports.fatfsjs_format(), 'format FATFS')
	}

	const alloc = (size: number) => {
		const ptr = size > 0 ? exports.malloc(size) : 0
		if (size > 0 && !ptr) throw new Error('Failed to allocate WebAssembly memory')
		return ptr
	}

	const allocString = (value: string) => {
		const encoded = textEncoder.encode(value)
		const ptr = alloc(encoded.length + 1)
		heap.set(encoded, ptr)
		heap[ptr + encoded.length] = 0
		return ptr
	}

	return {
		list(path = FAT_MOUNT) {
			const pathPtr = allocString(normalizeMountPath(path))
			let outPtr = 0
			try {
				outPtr = alloc(4096)
				const used = exports.fatfsjs_list(pathPtr, outPtr, 4096)
				assertOk(used, 'list FATFS files')
				const payload = textDecoder.decode(heap.subarray(outPtr, outPtr + used))
				return parseFatfsEntries(payload, normalizeMountPath(path))
			} finally {
				if (outPtr) exports.free(outPtr)
				exports.free(pathPtr)
			}
		},
		readFile(path) {
			const pathPtr = allocString(normalizeMountPath(path))
			let dataPtr = 0
			try {
				const size = exports.fatfsjs_file_size(pathPtr)
				assertOk(size, `stat FATFS file "${path}"`)
				dataPtr = alloc(size)
				const read = exports.fatfsjs_read_file(pathPtr, dataPtr, size)
				assertOk(read, `read FATFS file "${path}"`)
				return heap.slice(dataPtr, dataPtr + read)
			} finally {
				if (dataPtr) exports.free(dataPtr)
				exports.free(pathPtr)
			}
		},
		writeFile(path, data) {
			const pathPtr = allocString(normalizeMountPath(path))
			const dataPtr = alloc(data.length)
			try {
				heap.set(data, dataPtr)
				assertOk(exports.fatfsjs_write_file(pathPtr, dataPtr, data.length), `write FATFS file "${path}"`)
			} finally {
				if (dataPtr) exports.free(dataPtr)
				exports.free(pathPtr)
			}
		},
		deleteFile(path) {
			const pathPtr = allocString(normalizeMountPath(path))
			try {
				assertOk(exports.fatfsjs_delete_file(pathPtr), `delete FATFS file "${path}"`)
			} finally {
				exports.free(pathPtr)
			}
		},
		mkdir(path) {
			const pathPtr = allocString(normalizeMountPath(path))
			try {
				assertOk(exports.fatfsjs_mkdir(pathPtr), `mkdir FATFS "${path}"`)
			} finally {
				exports.free(pathPtr)
			}
		},
		rename(fromPath, toPath) {
			const fromPtr = allocString(normalizeMountPath(fromPath))
			const toPtr = allocString(normalizeMountPath(toPath))
			try {
				assertOk(exports.fatfsjs_rename(fromPtr, toPtr), `rename FATFS "${fromPath}"`)
			} finally {
				exports.free(fromPtr)
				exports.free(toPtr)
			}
		},
		format() {
			assertOk(exports.fatfsjs_format(), 'format FATFS')
			return Promise.resolve()
		},
		toImage() {
			const size = exports.fatfsjs_storage_size()
			const ptr = alloc(size)
			try {
				assertOk(exports.fatfsjs_export_image(ptr, size), 'export FATFS image')
				return Promise.resolve(heap.slice(ptr, ptr + size))
			} finally {
				if (ptr) exports.free(ptr)
			}
		},
		getUsage() {
			const capacityBytes = exports.fatfsjs_storage_size()
			return Promise.resolve({ capacityBytes, usedBytes: 0, freeBytes: capacityBytes })
		}
	} satisfies FfsTreeFilesystemClient
}

const parseFatfsEntries = (payload: string, basePath: string) =>
	payload
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [rawPath = '', rawSize = '0', rawType = 'f'] = line.split('\t')
			return {
				path: joinListPath(basePath, rawPath),
				size: Number(rawSize) || 0,
				type: rawType === 'd' ? 'dir' : 'file'
			}
		})

const normalizeMountPath = (input: string) => {
	const value = input.trim()
	if (!value || value === '/') return FAT_MOUNT
	return value.toLowerCase().startsWith(FAT_MOUNT) ? value : `${FAT_MOUNT}${value.startsWith('/') ? '' : '/'}${value}`
}

const joinListPath = (basePath: string, entryPath: string) => {
	const base = basePath.replace(/\/+$/, '')
	const trimmed = entryPath.replace(/^\/+/, '')
	return trimmed ? `${base}/${trimmed}` : base
}

const assertOk = (code: number, action: string) => {
	if (code < 0) throw new Error(`Unable to ${action}`)
}
