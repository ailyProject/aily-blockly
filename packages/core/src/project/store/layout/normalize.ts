import { HEADER_APP_LIMIT } from 'shared'

import { sanitizeAppZoneIds } from './zones'

import type { AppRegistryItem, AppStoreLayout } from 'shared'

/**
 * 归一化 AppStore 布局。
 * @param layout - 原始布局
 * @param headerLimit - header 区域上限
 * @param appMap - app 注册表
 */
export const normalizeAppStoreLayout = (
	layout: AppStoreLayout,
	headerLimit: number,
	appMap: Map<string, AppRegistryItem>
): AppStoreLayout => ({
	version: 2,
	zones: {
		header: sanitizeAppZoneIds('header', layout.zones.header || [], headerLimit, appMap)
	}
})

/**
 * 构建默认的 AppStore 布局。
 * @param defaultToolbarAppIds - 默认 header app id 列表
 * @param appMap - app 注册表
 */
export const createDefaultAppStoreLayout = (
	defaultToolbarAppIds: Array<string>,
	appMap: Map<string, AppRegistryItem>
): AppStoreLayout =>
	normalizeAppStoreLayout(
		{
			version: 2,
			zones: {
				header: defaultToolbarAppIds
			}
		},
		HEADER_APP_LIMIT,
		appMap
	)

/**
 * 从可见区域顺序与隐藏项集合回写新的 zone app id 列表。
 * @param currentZoneIds - 当前区域中的全部 app id
 * @param visibleIds - 当前仍可见且用户排序后的 id 列表
 * @param visibleCatalogIds - 当前 catalog 中属于“可见集合”的 id 列表
 */
export const mergeVisibleAppZoneOrder = (
	currentZoneIds: Array<string>,
	visibleIds: Array<string>,
	visibleCatalogIds: Array<string>
) => {
	const visibleCatalogIdSet = new Set(visibleCatalogIds)
	const preservedHiddenIds = currentZoneIds.filter(appId => !visibleCatalogIdSet.has(appId))

	return [...visibleIds, ...preservedHiddenIds]
}
