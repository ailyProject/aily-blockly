import { createLittlefsDirectoryBindings } from './directory'
import { createLittlefsImageBindings, initializeLittlefsModule } from './image'
import { allocLittlefs, allocLittlefsString, assertLittlefs } from './shared'

import type { FfsTreeFilesystemClient } from '../../filesystem/types'

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
	const module = await initializeLittlefsModule(options)
	const { list, deleteFile, deleteEntry, mkdir, rename } = createLittlefsDirectoryBindings(module)
	const imageBindings = createLittlefsImageBindings(module, options)

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
		delete: (path, deleteOptions = {}) => deleteEntry(path, deleteOptions.recursive === true),
		deleteFile,
		mkdir,
		rename,
		...imageBindings
	} satisfies FfsTreeFilesystemClient
}
