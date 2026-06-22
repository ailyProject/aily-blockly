/**
 * 规范化云端返回的包标识。
 * @param value - 云端原始字段
 */
export const normalizePackageSlugFromApi = (value: unknown) => {
	if (typeof value !== 'string') return ''
	let normalized = value.trim()
	const slashIndex = normalized.lastIndexOf('/')
	if (slashIndex >= 0) normalized = normalized.slice(slashIndex + 1)
	if (normalized.startsWith('@aily-project/')) normalized = normalized.slice('@aily-project/'.length)
	return normalized
}
