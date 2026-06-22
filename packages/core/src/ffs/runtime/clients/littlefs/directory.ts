import { allocLittlefs, allocLittlefsString, assertLittlefs, readLittlefsString } from './shared'

import type { LittlefsModule } from './shared'

const createLittlefsList =
	(module: LittlefsModule) =>
	(path = '/') => {
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

/**
 * 创建 LittleFS 目录相关操作。
 * @param module - LittleFS 模块实例
 */
export const createLittlefsDirectoryBindings = (module: LittlefsModule) => {
	const list = createLittlefsList(module)

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

	const mkdir = (path: string) => {
		const pathPtr = allocLittlefsString(module, path)
		try {
			const result = module._lfs_wasm_mkdir(pathPtr)
			if (result !== 0 && result !== -17) assertLittlefs(result, `mkdir LittleFS "${path}"`)
		} finally {
			module._free(pathPtr)
		}
	}

	const rename = (fromPath: string, toPath: string) => {
		const fromPtr = allocLittlefsString(module, fromPath)
		const toPtr = allocLittlefsString(module, toPath)
		try {
			assertLittlefs(module._lfs_wasm_rename(fromPtr, toPtr), `rename LittleFS "${fromPath}"`)
		} finally {
			module._free(fromPtr)
			module._free(toPtr)
		}
	}

	return {
		list,
		deleteFile,
		deleteEntry,
		mkdir,
		rename
	}
}
