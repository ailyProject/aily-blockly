import { littlefsWasmUrl, readFfsWasmBinary } from '../wasm'
import createLittlefsModule from '../wasm/littlefs/littlefs.js'
import { allocLittlefs, allocLittlefsString, assertLittlefs, readLittlefsString } from './littlefs.shared'

import type { FfsTreeFilesystemClient } from '../filesystem.types'
import type { LittlefsModule } from './littlefs.shared'

/**
 * 创建 LittleFS 客户端。
 * @param options - 初始化参数
 */
export const createLittlefsClient = async (options: {
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

	const deleteFile = (path: string) => {
		const pathPtr = allocLittlefsString(module, path)
		try {
			assertLittlefs(module._lfs_wasm_remove(pathPtr), `delete LittleFS "${path}"`)
		} finally {
			module._free(pathPtr)
		}
	}

	const deleteEntry = (path: string, recursive = false) => {
		if (recursive) {
			for (const entry of list(path)) {
				if (!entry.path) continue
				entry.type === 'dir' ? deleteEntry(entry.path, true) : deleteFile(entry.path)
			}
		}

		deleteFile(path)
	}

	const list = (path = '/') => {
		const entries: Array<{ path: string; name: string; size: number; type: 'file' | 'dir' }> = []
		const pathPtr = allocLittlefsString(module, path)
		const namePtr = allocLittlefs(module, 65)
		const typePtr = allocLittlefs(module, 4)
		const sizePtr = allocLittlefs(module, 4)
		let handle = -1
		try {
			handle = module._lfs_wasm_dir_open(pathPtr)
			assertLittlefs(handle, `open LittleFS directory "${path}"`)
			while (true) {
				const result = module._lfs_wasm_dir_read(handle, namePtr, 64, typePtr, sizePtr)
				if (result === 0) break
				assertLittlefs(result, `read LittleFS directory "${path}"`)
				const name = readLittlefsString(module, namePtr)
				if (!name || name === '.' || name === '..') continue
				const entryPath = path === '/' ? `/${name}` : `${path}/${name}`
				entries.push({
					path: entryPath,
					name,
					size: module.HEAPU32[sizePtr >> 2],
					type: module.HEAPU32[typePtr >> 2] === 2 ? 'dir' : 'file'
				})
			}
			return entries
		} finally {
			if (handle >= 0) module._lfs_wasm_dir_close(handle)
			module._free(pathPtr)
			module._free(namePtr)
			module._free(typePtr)
			module._free(sizePtr)
		}
	}

	return {
		list,
		readFile(path) {
			const pathPtr = allocLittlefsString(module, path)
			let dataPtr = 0
			try {
				const size = module._lfs_wasm_file_size(pathPtr)
				assertLittlefs(size, `stat LittleFS file "${path}"`)
				dataPtr = allocLittlefs(module, size)
				const read = module._lfs_wasm_read_file(pathPtr, dataPtr, size)
				assertLittlefs(read, `read LittleFS file "${path}"`)
				return module.HEAPU8.slice(dataPtr, dataPtr + read)
			} finally {
				if (dataPtr) module._free(dataPtr)
				module._free(pathPtr)
			}
		},
		writeFile(path, data) {
			const pathPtr = allocLittlefsString(module, path)
			const dataPtr = allocLittlefs(module, data.length)
			try {
				module.HEAPU8.set(data, dataPtr)
				assertLittlefs(module._lfs_wasm_write_file(pathPtr, dataPtr, data.length), `write LittleFS file "${path}"`)
			} finally {
				if (dataPtr) module._free(dataPtr)
				module._free(pathPtr)
			}
		},
		delete: (path, options = {}) => deleteEntry(path, options.recursive === true),
		deleteFile,
		mkdir(path) {
			const pathPtr = allocLittlefsString(module, path)
			try {
				const result = module._lfs_wasm_mkdir(pathPtr)
				if (result !== 0 && result !== -17) assertLittlefs(result, `mkdir LittleFS "${path}"`)
			} finally {
				module._free(pathPtr)
			}
		},
		rename(fromPath, toPath) {
			const fromPtr = allocLittlefsString(module, fromPath)
			const toPtr = allocLittlefsString(module, toPath)
			try {
				assertLittlefs(module._lfs_wasm_rename(fromPtr, toPtr), `rename LittleFS "${fromPath}"`)
			} finally {
				module._free(fromPtr)
				module._free(toPtr)
			}
		},
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
				if (result !== 0)
					return Promise.resolve({
						capacityBytes: options.blockSize * options.blockCount,
						usedBytes: 0,
						freeBytes: options.blockSize * options.blockCount
					})
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
	} satisfies FfsTreeFilesystemClient
}
