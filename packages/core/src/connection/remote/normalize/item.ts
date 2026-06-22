import { normalizePackageSlugFromApi } from './package'

/**
 * 从云端条目生成完整 pinmapId。
 * @param item - 当前云端条目
 */
export const buildPinmapIdFromApiItem = (item: Record<string, unknown>) => {
	for (const key of ['pinmapId', 'fullId', 'full_id', 'pin_map_id'] as const) {
		const value = item[key]
		if (typeof value === 'string' && value.includes(':')) return value
	}

	const library = normalizePackageSlugFromApi(
		item['library'] ?? item['librarySlug'] ?? item['packageSlug'] ?? item['package']
	)
	const model =
		(typeof item['modelId'] === 'string' && item['modelId']) ||
		(item['model'] && typeof (item['model'] as { id?: unknown }).id === 'string'
			? (item['model'] as { id: string }).id
			: null) ||
		(typeof item['slug'] === 'string' ? item['slug'] : null)
	const variant =
		(typeof item['variantId'] === 'string' && item['variantId']) ||
		(item['variant'] && typeof (item['variant'] as { id?: unknown }).id === 'string'
			? (item['variant'] as { id: string }).id
			: null) ||
		'default'

	return library && model ? `${library}:${model}:${variant}` : null
}

/**
 * 提取云端条目的版本号。
 * @param item - 当前云端条目
 */
export const extractCloudPinmapItemVersion = (item: Record<string, unknown>) => {
	const version = item['version'] ?? item['itemVersion']
	return typeof version === 'string' || typeof version === 'number' ? version : undefined
}
