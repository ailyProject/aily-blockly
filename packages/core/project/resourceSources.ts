import type { ResourceSourceConfig } from './types'

const normalizeResourceSourceUrl = (url: string) =>
	String(url || '')
		.trim()
		.replace(/\/+$/, '')

/**
 * 从旧区域配置构建资源源列表
 * @param {{ eu?: { resource?: string }, cn?: { resource?: string }, localhost?: { resource?: string } }} regions - 旧区域配置
 * @returns {ResourceSourceConfig[]}
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
 * @param {Array<Partial<ResourceSourceConfig>>} configuredSources - 原始资源源配置
 * @param {Parameters<typeof buildLegacyResourceSourceList>[0]} legacyRegions - 旧区域配置
 * @returns {ResourceSourceConfig[]}
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
 * @param {string | undefined} selectedKey - 原始选择值
 * @returns {string}
 */
export const normalizeSelectedResourceSourceKey = (selectedKey?: string) =>
	typeof selectedKey === 'string' && selectedKey.trim() ? selectedKey.trim() : 'auto'

/**
 * 判断是否为自动资源源选择
 * @param {string} selectedKey - 当前选择键
 * @returns {boolean}
 */
export const isAutoResourceSourceSelection = (selectedKey: string) => selectedKey === 'auto'

/**
 * 获取手动选择的资源源
 * @param {ResourceSourceConfig[]} sources - 可用资源源列表
 * @param {string} selectedKey - 当前选择键
 * @returns {ResourceSourceConfig | null}
 */
export const getManualResourceSource = (sources: Array<ResourceSourceConfig>, selectedKey: string) => {
	if (selectedKey === 'auto') return null
	return sources.find(source => source.key === selectedKey) || null
}

/**
 * 获取当前生效的资源源
 * @param {ResourceSourceConfig[]} sources - 可用资源源列表
 * @param {string} selectedKey - 当前选择键
 * @param {string | null | undefined} activeResourceSourceKey - 当前活跃资源源键
 * @returns {ResourceSourceConfig | null}
 */
export const getCurrentResourceSource = (
	sources: Array<ResourceSourceConfig>,
	selectedKey: string,
	activeResourceSourceKey?: string | null
) => {
	if (sources.length === 0) return null
	if (!isAutoResourceSourceSelection(selectedKey)) {
		return getManualResourceSource(sources, selectedKey) || sources[0]
	}

	return sources.find(source => source.key === activeResourceSourceKey) || sources[0]
}

/**
 * 获取资源源候选顺序
 * @param {ResourceSourceConfig[]} sources - 可用资源源列表
 * @param {string} selectedKey - 当前选择键
 * @param {string | null | undefined} activeResourceSourceKey - 当前活跃资源源键
 * @returns {ResourceSourceConfig[]}
 */
export const getResourceSourceCandidates = (
	sources: Array<ResourceSourceConfig>,
	selectedKey: string,
	activeResourceSourceKey?: string | null
) => {
	if (sources.length === 0) return []
	if (!isAutoResourceSourceSelection(selectedKey)) {
		return [getManualResourceSource(sources, selectedKey) || sources[0]]
	}

	const currentSource = getCurrentResourceSource(sources, selectedKey, activeResourceSourceKey)
	if (!currentSource) return sources

	return [currentSource, ...sources.filter(source => source.key !== currentSource.key)]
}

/**
 * 构建资源 zip URL 候选列表
 * @param {ResourceSourceConfig[]} candidates - 资源源候选列表
 * @returns {string[]}
 */
export const buildZipUrlCandidates = (candidates: Array<ResourceSourceConfig>) => {
	const seenUrls = new Set<string>()
	const urls: Array<string> = []

	for (const source of candidates) {
		if (!source.url || seenUrls.has(source.url)) continue
		seenUrls.add(source.url)
		urls.push(source.url)
	}

	return urls
}
