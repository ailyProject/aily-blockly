type SpiffsExports = WebAssembly.Exports & {
	memory: WebAssembly.Memory
	malloc(size: number): number
	free(ptr: number): void
	spiffsjs_init(pageSize: number, blockSize: number, blockCount: number, fdCount: number, cachePages: number): number
	spiffsjs_init_from_image(
		pageSize: number,
		blockSize: number,
		blockCount: number,
		fdCount: number,
		cachePages: number,
		ptr: number,
		size: number
	): number
	spiffsjs_list(outPtr: number, capacity: number): number
	spiffsjs_file_size(pathPtr: number): number
	spiffsjs_read_file(pathPtr: number, outPtr: number, size: number): number
	spiffsjs_write_file(pathPtr: number, dataPtr: number, size: number): number
	spiffsjs_remove_file(pathPtr: number): number
	spiffsjs_format(): number
	spiffsjs_storage_size(): number
	spiffsjs_export_image(ptr: number, size: number): number
	spiffsjs_get_usage(ptr: number): number
}

const textEncoder = new TextEncoder()

/**
 * 规整 SPIFFS 路径。
 * @param input - 原始路径
 */
export const normalizeSpiffsPath = (input: string) => {
	const trimmed = input.trim().replace(/^\/+/, '')
	if (!trimmed || trimmed.includes('/')) throw new Error('SPIFFS paths must refer to a single file name')
	return `/${trimmed}`
}

/**
 * 解析 SPIFFS 列表结果。
 * @param payload - 原始文本载荷
 */
export const parseSpiffsEntries = (payload: string) =>
	payload
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [name = '', type = 'file', size = '0'] = line.split('\t')
			return {
				name,
				path: `/${name.replace(/^\/+/, '')}`,
				type: type === 'dir' ? 'dir' : 'file',
				size: Number(size) || 0
			}
		})

/**
 * 为 SPIFFS 分配 Wasm 堆内存。
 * @param exports - Wasm 导出对象
 * @param size - 目标大小
 */
export const allocSpiffs = (exports: SpiffsExports, size: number) => {
	const ptr = size > 0 ? exports.malloc(size) : 0
	if (size > 0 && !ptr) throw new Error('Failed to allocate WebAssembly memory')
	return ptr
}

/**
 * 为 SPIFFS 分配并写入字符串。
 * @param exports - Wasm 导出对象
 * @param heap - 线性内存视图
 * @param value - 字符串值
 */
export const allocSpiffsString = (exports: SpiffsExports, heap: Uint8Array, value: string) => {
	const encoded = textEncoder.encode(value)
	const ptr = allocSpiffs(exports, encoded.length + 1)
	heap.set(encoded, ptr)
	heap[ptr + encoded.length] = 0
	return ptr
}

/**
 * 对 SPIFFS 原生返回码做断言。
 * @param code - 原生返回码
 * @param action - 当前动作说明
 */
export const assertSpiffs = (code: number, action: string) => {
	if (code < 0) throw new Error(`Unable to ${action}`)
}

export type { SpiffsExports }
