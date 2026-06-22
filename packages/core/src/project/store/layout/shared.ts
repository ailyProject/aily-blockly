import type { AppPlacementZone, AppRegistryItem } from 'shared'

/**
 * 判断某个 app 是否允许进入布局。
 * @param appMap - app 注册表
 * @param appId - 目标 app ID
 */
export const canRegisterApp = (appMap: Map<string, AppRegistryItem>, appId: string) => {
	const app = appMap.get(appId)
	return Boolean(app && app.enabled !== false)
}

/**
 * 判断某个 app 是否被锁定。
 * @param appMap - app 注册表
 * @param appId - 目标 app ID
 */
export const isAppLocked = (appMap: Map<string, AppRegistryItem>, appId: string) => appMap.get(appId)?.lock === true

/**
 * 读取当前布局里某个区域的 app ID 列表。
 * @param layout - 当前布局
 * @param zone - 目标区域
 */
export const getLayoutZoneIds = (
	layout: { zones: Partial<Record<AppPlacementZone, Array<string>>> },
	zone: AppPlacementZone
) => [...(layout.zones[zone] ?? [])]

/**
 * 获取需要强制保留在布局中的锁定 app。
 * @param appMap - app 注册表
 */
export const getLockedZoneIds = (appMap: Map<string, AppRegistryItem>) =>
	[...appMap.values()].filter(app => app.lock === true && canRegisterApp(appMap, app.id)).map(app => app.id)
