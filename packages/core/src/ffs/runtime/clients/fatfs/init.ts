import { assertFatfsOk } from './shared'

/**
 * 初始化 FATFS wasm 存储状态。
 * @param exports - wasm 导出对象
 * @param memory - 内存辅助
 * @param options - 初始化参数
 */
export const initializeFatfsClient = (
	exports: {
		malloc(size: number): number
		free(ptr: number): void
		fatfsjs_init(blockSize: number, blockCount: number): number
		fatfsjs_init_from_image(ptr: number, size: number): number
		fatfsjs_format(): number
	},
	memory: { heap: Uint8Array },
	options: { image?: Uint8Array; blockSize: number; blockCount: number }
) => {
	if (options.image) {
		const imagePtr = exports.malloc(options.image.length || 1)
		memory.heap.set(options.image, imagePtr)
		try {
			assertFatfsOk(exports.fatfsjs_init_from_image(imagePtr, options.image.length), 'initialize FATFS image')
		} finally {
			exports.free(imagePtr)
		}
		return
	}

	assertFatfsOk(exports.fatfsjs_init(options.blockSize, options.blockCount), 'initialize FATFS')
	assertFatfsOk(exports.fatfsjs_format(), 'format FATFS')
}
