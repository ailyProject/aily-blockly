import type { RegionConfigMap } from '../types'

/**
 * 规范化构建风味
 * @param flavor - 原始构建风味
 * @param defaultBuildFlavor - 默认构建风味
 */
export const normalizeBuildFlavor = (flavor: string | undefined, defaultBuildFlavor: string) =>
	flavor === 'global' ? 'global' : defaultBuildFlavor

/**
 * 解析官方区域键
 * @param input - 区域选择输入
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
 * @param regions - 区域配置映射
 * @param regionKey - 区域键
 */
export const isOfficialRegionKey = (regions: RegionConfigMap | undefined, regionKey: string) => {
	const regionConfig = regions?.[regionKey]
	if (!regionConfig) return false
	if (typeof regionConfig.official === 'boolean') return regionConfig.official
	return regionKey === 'cn' || regionKey === 'eu'
}

/**
 * 判断区域是否允许被选择
 * @param input - 区域选择输入
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
 * @param regions - 区域配置映射
 * @param regionKey - 当前区域键
 * @param fallbackRegionKey - 兜底区域键
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
 * @param regionKey - 当前区域键
 */
export const isCnRegion = (regionKey: string | undefined) => (regionKey || 'cn').toLowerCase() === 'cn'
