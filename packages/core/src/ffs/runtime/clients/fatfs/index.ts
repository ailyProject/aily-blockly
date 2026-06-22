import { fatfsWasmUrl } from '../../wasm'
import { instantiateFfsWasmModule } from '../shared'
import { createFatfsFileBindings } from './files'
import { createFatfsImageBindings } from './image'
import { initializeFatfsClient } from './init'
import { createFatfsMemoryHelpers } from './memory'

import type { FfsTreeFilesystemClient } from '../../filesystem/types'

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

/**
 * 创建 FatFS 客户端。
 * @param options - 初始化参数
 */
export const createFatfsClient = async (options: { image?: Uint8Array; blockSize: number; blockCount: number }) => {
	const exports = (await instantiateFfsWasmModule(fatfsWasmUrl)) as FatfsExports
	const memory = createFatfsMemoryHelpers(exports)
	initializeFatfsClient(exports, memory, options)
	const fileBindings = createFatfsFileBindings({ exports, memory })
	const imageBindings = createFatfsImageBindings({ exports, memory })

	return {
		...fileBindings,
		...imageBindings
	} satisfies FfsTreeFilesystemClient
}
