const FAT_MOUNT = '/fatfs'

/**
 * 归一化 FATFS 挂载路径。
 * @param input - 外部传入路径
 */
export const normalizeFatfsMountPath = (input: string) => {
	const value = input.trim()
	if (!value || value === '/') return FAT_MOUNT
	return value.toLowerCase().startsWith(FAT_MOUNT) ? value : `${FAT_MOUNT}${value.startsWith('/') ? '' : '/'}${value}`
}

/**
 * 拼接 FATFS 列表项路径。
 * @param basePath - 当前目录
 * @param entryPath - 列表项路径
 */
export const joinFatfsListPath = (basePath: string, entryPath: string) => {
	const base = basePath.replace(/\/+$/, '')
	const trimmed = entryPath.replace(/^\/+/, '')
	return trimmed ? `${base}/${trimmed}` : base
}

/**
 * 校验 FATFS wasm 调用结果。
 * @param code - wasm 返回码
 * @param action - 当前动作描述
 */
export const assertFatfsOk = (code: number, action: string) => {
	if (code < 0) throw new Error(`Unable to ${action}`)
}
