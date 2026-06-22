import type { ResourceSourceConfig } from '../types'

/**
 * 规整资源源 URL。
 * @param url - 原始 URL
 */
export const normalizeResourceSourceUrl = (url: string) =>
	String(url || '')
		.trim()
		.replace(/\/+$/, '')

/**
 * 从旧区域配置构建资源源列表
 * @param regions - 旧区域配置
 */
export const buildLegacyResourceSourceList = (regions?: {
	eu?: { resource?: string }
	cn?: { resource?: string }
	localhost?: { resource?: string }
}): Array<ResourceSourceConfig> => {
	const fallbackSources = [
		{ key: 'primary', url: regions?.eu?.resource },
		{ key: 'mirror', url: regions?.cn?.resource },
		{ key: 'localhost', url: regions?.localhost?.resource }
	]
	const seenUrls = new Set<string>()
	const normalizedSources: Array<ResourceSourceConfig> = []

	for (const source of fallbackSources) {
		const url = normalizeResourceSourceUrl(source.url || '')
		if (!url || seenUrls.has(url)) continue

		seenUrls.add(url)
		normalizedSources.push({
			key: source.key,
			url,
			enabled: true
		})
	}

	return normalizedSources
}

/**
 * 归一化资源源列表
 * @param configuredSources - 原始资源源配置
 * @param legacyRegions - 旧区域配置
 */
export const normalizeResourceSourceList = (
	configuredSources: Array<Partial<ResourceSourceConfig>>,
	legacyRegions?: Parameters<typeof buildLegacyResourceSourceList>[0]
) => {
	const seenUrls = new Set<string>()
	const normalizedSources: Array<ResourceSourceConfig> = []

	for (const source of configuredSources) {
		const url = normalizeResourceSourceUrl(source?.url || '')
		if (!url || source?.enabled === false || seenUrls.has(url)) continue

		seenUrls.add(url)
		normalizedSources.push({
			key:
				typeof source.key === 'string' && source.key.trim()
					? source.key.trim()
					: `resource_${normalizedSources.length + 1}`,
			name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : undefined,
			url,
			enabled: source.enabled === undefined ? true : source.enabled
		})
	}

	return normalizedSources.length > 0 ? normalizedSources : buildLegacyResourceSourceList(legacyRegions)
}

/**
 * 解析资源源选择键
 * @param selectedKey - 原始选择值
 */
export const normalizeSelectedResourceSourceKey = (selectedKey?: string) =>
	typeof selectedKey === 'string' && selectedKey.trim() ? selectedKey.trim() : 'auto'
