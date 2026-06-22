import { isRegionSelectable } from './base'

import type { RegionConfigMap, RegionListItem } from '../types'

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
			isRegionSelectable({
				regions: input.regions,
				regionKey: region.key,
				officialRegionKey: input.officialRegionKey
			})
	)
