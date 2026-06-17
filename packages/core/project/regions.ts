import type { BuildFlavor, RegionConfigMap } from './types'

/**
 * 规范化构建风味
 * @param {string | undefined} flavor - 原始构建风味
 * @param {string} defaultBuildFlavor - 默认构建风味
 * @returns {string}
 */
export const normalizeBuildFlavor = (flavor: string | undefined, defaultBuildFlavor: string) =>
	flavor === 'global' ? 'global' : defaultBuildFlavor

/**
 * 解析官方区域键
 * @param {{ officialRegion?: string; buildFlavor?: string; defaultBuildFlavor: string; defaultOfficialRegion: string }} input - 区域选择输入
 * @returns {string}
 */
export const resolveOfficialRegionKey = (input: {
	officialRegion?: string
	buildFlavor?: string
	defaultBuildFlavor: string
	defaultOfficialRegion: string
}) => {
	if (typeof input.officialRegion === 'string' && input.officialRegion) {
		return input.officialRegion
	}

	return normalizeBuildFlavor(input.buildFlavor, input.defaultBuildFlavor) === 'global'
		? 'eu'
		: input.defaultOfficialRegion
}

/**
 * 判断区域是否为官方区域
 * @param {RegionConfigMap | undefined} regions - 区域配置映射
 * @param {string} regionKey - 区域键
 * @returns {boolean}
 */
export const isOfficialRegionKey = (regions: RegionConfigMap | undefined, regionKey: string) => {
	const regionConfig = regions?.[regionKey]
	if (!regionConfig) return false
	if (typeof regionConfig.official === 'boolean') return regionConfig.official
	return regionKey === 'cn' || regionKey === 'eu'
}

/**
 * 判断区域是否允许被选择
 * @param {{ regions?: RegionConfigMap; regionKey: string; officialRegionKey: string }} input - 区域选择输入
 * @returns {boolean}
 */
export const isRegionSelectable = (input: {
	regions?: RegionConfigMap
	regionKey: string
	officialRegionKey: string
}) => {
	if (!input.regions?.[input.regionKey]) return false
	if (!isOfficialRegionKey(input.regions, input.regionKey)) return true
	return input.regionKey === input.officialRegionKey
}

/**
 * 获取当前区域配置
 * @param {RegionConfigMap | undefined} regions - 区域配置映射
 * @param {string | undefined} regionKey - 当前区域键
 * @param {string} fallbackRegionKey - 兜底区域键
 * @returns {RegionConfigMap[string] | undefined}
 */
export const getCurrentRegionConfig = (
	regions: RegionConfigMap | undefined,
	regionKey: string | undefined,
	fallbackRegionKey: string
) => {
	const currentRegionKey = regionKey || fallbackRegionKey
	return regions?.[currentRegionKey] || regions?.[fallbackRegionKey]
}

/**
 * 判断当前区域是否为中国区
 * @param {string | undefined} regionKey - 当前区域键
 * @returns {boolean}
 */
export const isCnRegion = (regionKey: string | undefined) => (regionKey || 'cn').toLowerCase() === 'cn'

/**
 * 获取当前区域资源 URL
 * @param {{ currentSourceUrl?: string | null; regions?: RegionConfigMap; regionKey?: string; fallbackRegionKey: string }} input - 输入参数
 * @returns {string}
 */
export const getCurrentResourceUrl = (input: {
	currentSourceUrl?: string | null
	regions?: RegionConfigMap
	regionKey?: string
	fallbackRegionKey: string
}) => {
	const regionConfig = getCurrentRegionConfig(input.regions, input.regionKey, input.fallbackRegionKey)
	return input.currentSourceUrl || regionConfig?.resource || ''
}

/**
 * 获取当前区域 NPM Registry
 * @param {RegionConfigMap | undefined} regions - 区域配置映射
 * @param {string | undefined} regionKey - 当前区域键
 * @param {string} fallbackRegionKey - 兜底区域键
 * @returns {string}
 */
export const getCurrentNpmRegistry = (
	regions: RegionConfigMap | undefined,
	regionKey: string | undefined,
	fallbackRegionKey: string
) => getCurrentRegionConfig(regions, regionKey, fallbackRegionKey)?.npm_registry || ''

/**
 * 获取当前区域 API Server
 * @param {RegionConfigMap | undefined} regions - 区域配置映射
 * @param {string | undefined} regionKey - 当前区域键
 * @param {string} fallbackRegionKey - 兜底区域键
 * @returns {string}
 */
export const getCurrentApiServer = (
	regions: RegionConfigMap | undefined,
	regionKey: string | undefined,
	fallbackRegionKey: string
) => getCurrentRegionConfig(regions, regionKey, fallbackRegionKey)?.api_server || ''
