type LittlefsModule = Record<string, unknown> & {
	HEAPU8: Uint8Array
	HEAPU32: Uint32Array
	_malloc(size: number): number
	_free(ptr: number): void
	_lfs_wasm_init(blockSize: number, blockCount: number, lookaheadSize: number): number
	_lfs_wasm_init_from_image(
		ptr: number,
		size: number,
		blockSize: number,
		blockCount: number,
		lookaheadSize: number
	): number
	_lfs_wasm_mount(): number
	_lfs_wasm_unmount(): number
	_lfs_wasm_format(): number
	_lfs_wasm_mkdir(pathPtr: number): number
	_lfs_wasm_remove(pathPtr: number): number
	_lfs_wasm_rename(fromPtr: number, toPtr: number): number
	_lfs_wasm_dir_open(pathPtr: number): number
	_lfs_wasm_dir_read(handle: number, namePtr: number, maxLength: number, typePtr: number, sizePtr: number): number
	_lfs_wasm_dir_close(handle: number): number
	_lfs_wasm_write_file(pathPtr: number, dataPtr: number, size: number): number
	_lfs_wasm_read_file(pathPtr: number, dataPtr: number, size: number): number
	_lfs_wasm_file_size(pathPtr: number): number
	_lfs_wasm_get_image(): number
	_lfs_wasm_get_image_size(): number
	_lfs_wasm_fs_stat(usedPtr: number, totalPtr: number): number
	_lfs_wasm_cleanup(): number
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * 为 LittleFS 分配 Wasm 堆内存。
 * @param module - LittleFS 模块实例
 * @param size - 目标大小
 */
export const allocLittlefs = (module: LittlefsModule, size: number) => {
	const ptr = size > 0 ? module._malloc(size) : 0
	if (size > 0 && !ptr) throw new Error('Failed to allocate LittleFS memory')
	return ptr
}

/**
 * 为 LittleFS 分配并写入字符串。
 * @param module - LittleFS 模块实例
 * @param value - 字符串值
 */
export const allocLittlefsString = (module: LittlefsModule, value: string) => {
	const encoded = textEncoder.encode(`${value}\0`)
	const ptr = allocLittlefs(module, encoded.length)
	module.HEAPU8.set(encoded, ptr)
	return ptr
}

/**
 * 从 LittleFS 模块线性内存中读取字符串。
 * @param module - LittleFS 模块实例
 * @param ptr - 字符串起始地址
 */
export const readLittlefsString = (module: LittlefsModule, ptr: number) => {
	let end = ptr
	while (module.HEAPU8[end] !== 0) end += 1
	return textDecoder.decode(module.HEAPU8.subarray(ptr, end))
}

/**
 * 对 LittleFS 原生返回码做断言。
 * @param code - 原生返回码
 * @param action - 当前动作说明
 */
export const assertLittlefs = (code: number, action: string) => {
	if (code < 0) throw new Error(`Unable to ${action}`)
}

export type { LittlefsModule }
