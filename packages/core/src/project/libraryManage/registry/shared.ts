const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, '')

/**
 * 规整 Blockly 库 registry 地址。
 * @param registry - 外部传入的可选 registry 地址
 */
export const normalizeProjectBlocklyRegistryUrl = (registry?: string) =>
	trimTrailingSlash(registry?.trim() || DEFAULT_NPM_REGISTRY)

/**
 * 把 Blockly 库包名转换为更适合界面展示的标题。
 * @param packageName - Blockly 库包名
 */
export const humanizeProjectBlocklyLibraryName = (packageName: string) =>
	packageName
		.replace(/^@aily-project\/lib-/, '')
		.split(/[-_]+/)
		.filter(Boolean)
		.map(token => token.charAt(0).toUpperCase() + token.slice(1))
		.join(' ')

/**
 * 解析 `name@version` 形式的 registry 列表条目。
 * @param value - 原始列表值
 */
export const parseProjectBlocklyRegistryPackageVersion = (value: string) => {
	const normalized = value.trim()
	const versionSeparatorIndex = normalized.lastIndexOf('@')
	if (versionSeparatorIndex <= 0 || versionSeparatorIndex === normalized.length - 1) {
		return null
	}

	return {
		name: normalized.slice(0, versionSeparatorIndex),
		version: normalized.slice(versionSeparatorIndex + 1)
	}
}

/**
 * 按版本号从新到旧排序 registry 版本文本。
 * @param left - 左侧版本
 * @param right - 右侧版本
 */
export const compareProjectBlocklyRegistryVersion = (left: string, right: string) =>
	right.localeCompare(left, undefined, {
		numeric: true,
		sensitivity: 'base'
	})
