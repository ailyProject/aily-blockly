import { readFfsWasmBinary } from '../wasm'

const textDecoder = new TextDecoder()

type WasmContext = {
	memory: WebAssembly.Memory | null
}

/**
 * 从导出对象中解析出 WebAssembly 线性内存。
 * @param exports - 模块导出对象
 */
export const getFfsExportedMemory = (exports: WebAssembly.Exports) => {
	for (const value of Object.values(exports)) {
		if (value instanceof WebAssembly.Memory) return value
	}

	return null
}

/**
 * 创建兼容当前 FFS Wasm 模块的基础 importObject。
 * @param context - 用于回填 Memory 的上下文
 */
export const createFfsWasmImports = (context: WasmContext): WebAssembly.Imports => ({
	env: {
		emscripten_notify_memory_growth: () => undefined
	},
	wasi_snapshot_preview1: {
		fd_close: () => 0,
		fd_seek: () => 0,
		fd_write: (fd: number, iov: number, iovcnt: number, pnum: number) => handleFdWrite(context, fd, iov, iovcnt, pnum)
	}
})

/**
 * 读取并实例化原生 Wasm 模块。
 * @param url - Wasm 文件地址
 */
export const instantiateFfsWasmModule = async (url: URL) => {
	const context: WasmContext = { memory: null }
	const binary = await readFfsWasmBinary(url)
	const { instance } = await WebAssembly.instantiate(binary, createFfsWasmImports(context))
	context.memory = getFfsExportedMemory(instance.exports)
	return instance.exports
}

const handleFdWrite = (context: WasmContext, fd: number, iov: number, iovcnt: number, pnum: number) => {
	if (!context.memory) return 0

	const view = new DataView(context.memory.buffer)
	let total = 0
	for (let index = 0; index < iovcnt; index += 1) {
		const base = iov + index * 8
		const ptr = view.getUint32(base, true)
		const len = view.getUint32(base + 4, true)
		total += len

		if (fd === 1 || fd === 2) {
			const text = textDecoder.decode(new Uint8Array(context.memory.buffer, ptr, len))
			console.info(`[ffs-wasm::fd_write fd=${fd}] ${text}`)
		}
	}

	view.setUint32(pnum, total, true)
	return 0
}
