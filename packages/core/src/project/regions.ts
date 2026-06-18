import type { BuildFlavor, RegionConfigMap, RegionListItem } from './types'

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

/**
 * 获取当前区域资源 URL
 * @param input - 输入参数
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
 * @param regions - 区域配置映射
 * @param regionKey - 当前区域键
 * @param fallbackRegionKey - 兜底区域键
 */
export const getCurrentNpmRegistry = (
	regions: RegionConfigMap | undefined,
	regionKey: string | undefined,
	fallbackRegionKey: string
) => getCurrentRegionConfig(regions, regionKey, fallbackRegionKey)?.npm_registry || ''

/**
 * 获取当前区域 API Server
 * @param regions - 区域配置映射
 * @param regionKey - 当前区域键
 * @param fallbackRegionKey - 兜底区域键
 */
export const getCurrentApiServer = (
	regions: RegionConfigMap | undefined,
	regionKey: string | undefined,
	fallbackRegionKey: string
) => getCurrentRegionConfig(regions, regionKey, fallbackRegionKey)?.api_server || ''

/**
 * 获取当前区域更新器地址
 * @param regions - 区域配置映射
 * @param regionKey - 当前区域键
 * @param fallbackRegionKey - 兜底区域键
 */
export const getCurrentUpdaterUrl = (
	regions: RegionConfigMap | undefined,
	regionKey: string | undefined,
	fallbackRegionKey: string
) => getCurrentRegionConfig(regions, regionKey, fallbackRegionKey)?.updater || ''

const trimTrailingSlash = (url: string) => (url.endsWith('/') ? url.slice(0, -1) : url)

/**
 * 获取当前 Web 站点地址
 * @param input - 输入参数
 */
export const getCurrentWebUrl = (input: {
	regions?: RegionConfigMap
	regionKey?: string
	fallbackRegionKey: string
	fallbackWeb?: string
}) => {
	const url =
		getCurrentRegionConfig(input.regions, input.regionKey, input.fallbackRegionKey)?.web ||
		input.fallbackWeb ||
		'https://aily.pro'
	return trimTrailingSlash(url)
}

/**
 * 获取当前用户中心地址
 * @param input - 输入参数
 */
export const getCurrentUcenterWebUrl = (input: {
	regions?: RegionConfigMap
	regionKey?: string
	fallbackRegionKey: string
	fallbackUcenterWeb?: string
}) => {
	const url =
		getCurrentRegionConfig(input.regions, input.regionKey, input.fallbackRegionKey)?.ucenter_web ||
		input.fallbackUcenterWeb ||
		'https://c.aily.pro'
	return trimTrailingSlash(url)
}

/**
 * 获取全部区域列表
 * @param regions - 区域配置映射
 */
export const getRegionList = (regions: RegionConfigMap | undefined): Array<RegionListItem> => {
	if (!regions) return []

	return Object.keys(regions).map(key => ({
		key,
		name: regions[key].name || key,
		enabled: regions[key].enabled !== false
	}))
}

/**
 * 获取启用且允许选择的区域列表
 * @param input - 输入参数
 */
export const getEnabledRegionList = (input: { regions?: RegionConfigMap; officialRegionKey: string }) =>
	getRegionList(input.regions).filter(
		region =>
			region.enabled &&
			isRegionSelectable({ regions: input.regions, regionKey: region.key, officialRegionKey: input.officialRegionKey })
	)
