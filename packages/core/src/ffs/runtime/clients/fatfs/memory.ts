const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * 创建 FATFS wasm 的内存访问辅助。
 * @param exports - wasm 导出对象
 */
export const createFatfsMemoryHelpers = (exports: {
	memory: WebAssembly.Memory
	malloc(size: number): number
	free(ptr: number): void
}) => {
	const heap = new Uint8Array(exports.memory.buffer)

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

	const decode = (ptr: number, size: number) => textDecoder.decode(heap.subarray(ptr, ptr + size))

	return {
		heap,
		alloc,
		allocString,
		decode
	}
}
