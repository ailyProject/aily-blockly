import { HEADER_APP_LIMIT } from 'shared'

import { createDefaultAppStoreLayout, normalizeAppStoreLayout, sanitizeAppZoneIds } from './appStore'

import type { AppPlacementZone, AppRegistryItem, AppStoreLayout } from 'shared'

const canRegisterApp = (appMap: Map<string, AppRegistryItem>, appId: string) => {
	const app = appMap.get(appId)
	return Boolean(app && app.enabled !== false)
}

const isAppLocked = (appMap: Map<string, AppRegistryItem>, appId: string) => appMap.get(appId)?.lock === true

/**
 * 从布局中读取某个区域的 app id 列表。
 * @param layout - 当前布局
 * @param zone - 目标区域
 */
export const getLayoutZoneIds = (layout: AppStoreLayout, zone: AppPlacementZone) => [...(layout.zones[zone] ?? [])]

/**
 * 覆盖设置某个区域的 app 列表，并做归一化。
 * @param layout - 当前布局
 * @param zone - 目标区域
 * @param appIds - 新 app id 列表
 * @param appMap - app 注册表
 */
export const setLayoutZoneApps = (
	layout: AppStoreLayout,
	zone: AppPlacementZone,
	appIds: Array<string>,
	appMap: Map<string, AppRegistryItem>
): AppStoreLayout => ({
	...layout,
	zones: {
		...layout.zones,
		[zone]: sanitizeAppZoneIds(zone, appIds, HEADER_APP_LIMIT, appMap)
	}
})

/**
 * 向某个区域追加一个 app。
 * @param layout - 当前布局
 * @param zone - 目标区域
 * @param appId - 待追加 app id
 * @param appMap - app 注册表
 */
export const addLayoutApp = (
	layout: AppStoreLayout,
	zone: AppPlacementZone,
	appId: string,
	appMap: Map<string, AppRegistryItem>
): AppStoreLayout => {
	if (!canRegisterApp(appMap, appId)) return layout

	const current = getLayoutZoneIds(layout, zone)
	if (current.includes(appId) || current.length >= HEADER_APP_LIMIT) return layout

	return setLayoutZoneApps(layout, zone, [...current, appId], appMap)
}

/**
 * 从某个区域移除一个 app。
 * @param layout - 当前布局
 * @param zone - 目标区域
 * @param appId - 待移除 app id
 * @param appMap - app 注册表
 */
export const removeLayoutApp = (
	layout: AppStoreLayout,
	zone: AppPlacementZone,
	appId: string,
	appMap: Map<string, AppRegistryItem>
): AppStoreLayout => {
	if (isAppLocked(appMap, appId)) return layout
	return setLayoutZoneApps(
		layout,
		zone,
		getLayoutZoneIds(layout, zone).filter(id => id !== appId),
		appMap
	)
}

/**
 * 切换某个 app 在区域中的存在状态。
 * @param layout - 当前布局
 * @param zone - 目标区域
 * @param appId - 目标 app id
 * @param appMap - app 注册表
 */
export const toggleLayoutApp = (
	layout: AppStoreLayout,
	zone: AppPlacementZone,
	appId: string,
	appMap: Map<string, AppRegistryItem>
) =>
	getLayoutZoneIds(layout, zone).includes(appId)
		? removeLayoutApp(layout, zone, appId, appMap)
		: addLayoutApp(layout, zone, appId, appMap)

/**
 * 重置布局到默认状态。
 * @param defaultToolbarAppIds - 默认 toolbar app id
 * @param appMap - app 注册表
 */
export const resetLayout = (defaultToolbarAppIds: Array<string>, appMap: Map<string, AppRegistryItem>) =>
	normalizeAppStoreLayout(createDefaultAppStoreLayout(defaultToolbarAppIds, appMap), HEADER_APP_LIMIT, appMap)
