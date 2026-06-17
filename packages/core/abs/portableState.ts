/**
 * 创建可移植的 extraState
 * @param {unknown} extraState - 原始 extraState
 * @returns {Record<string, unknown> | null}
 */
export const makePortableExtraState = (extraState: unknown): Record<string, unknown> | null => {
	if (!extraState || typeof extraState !== 'object') {
		return extraState as Record<string, unknown> | null
	}

	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(extraState)) {
		if (typeof value === 'string' && value.includes('::')) continue
		if (
			Array.isArray(value) &&
			value.length > 0 &&
			value.every(item => typeof item === 'string' && item.includes('::'))
		) {
			continue
		}
		result[key] = value
	}

	return Object.keys(result).length > 0 ? result : null
}
