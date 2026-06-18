import { HEADER_APP_LIMIT } from 'shared'

import type { AppPlacementZone, AppRegistryItem, AppStoreLayout, AppVisibilityContext } from 'shared'

/**
 * 读取配置中的 toolbar app id 列表。
 * @param config - 当前应用配置
 * @param storageKey - 配置存储键
 */
export const readToolbarAppIdsFromConfig = (config: Record<string, unknown> | null | undefined, storageKey: string) => {
	const value = config?.[storageKey]
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null
}

const canRegisterApp = (appMap: Map<string, AppRegistryItem>, appId: string) => {
	const app = appMap.get(appId)
	return Boolean(app && app.enabled !== false)
}

const getLockedZoneIds = (appMap: Map<string, AppRegistryItem>) =>
	[...appMap.values()].filter(app => app.lock === true && canRegisterApp(appMap, app.id)).map(app => app.id)

/**
 * 归一化某个区域中的 app id 列表。
 * @param zone - 目标区域
 * @param appIds - 原始 app id 列表
 * @param limit - 区域容量上限
 * @param appMap - app 注册表
 */
export const sanitizeAppZoneIds = (
	zone: AppPlacementZone,
	appIds: Array<string>,
	limit: number,
	appMap: Map<string, AppRegistryItem>
) => {
	const lockedIds = getLockedZoneIds(appMap)
	const lockedIdSet = new Set(lockedIds)
	const maxNonLockedCount = Math.max(limit - lockedIds.length, 0)
	const seen = new Set<string>()
	const result: Array<string> = []
	let nonLockedCount = 0

	for (const appId of [...appIds, ...lockedIds]) {
		if (result.length >= limit) break
		if (seen.has(appId) || !canRegisterApp(appMap, appId)) continue

		const isLocked = lockedIdSet.has(appId)
		if (!isLocked && nonLockedCount >= maxNonLockedCount) continue

		seen.add(appId)
		result.push(appId)

		if (!isLocked) {
			nonLockedCount += 1
		}
	}

	return result
}

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

const matchesAppCore = (appCore: string, currentCore: string) => {
	const normalizedAppCore = appCore.toLowerCase()
	return currentCore === normalizedAppCore || currentCore.split(':').includes(normalizedAppCore)
}

/**
 * 判断某个 app 在当前上下文中是否可见。
 * @param app - app 注册项
 * @param context - 当前可见性上下文
 */
export const isAppVisibleInContext = (app: AppRegistryItem, context: AppVisibilityContext = {}) => {
	if (app.enabled === false) return false
	if (app.dev && !context.isDevMode) return false

	if (app.router?.length && context.routeUrl) {
		const inRoute = app.router.some(route => context.routeUrl?.includes(route))
		if (!inRoute) return false
	}

	if (app.core?.length) {
		const currentCore = String(context.boardCore || '').toLowerCase()
		return app.core.some(core => matchesAppCore(core, currentCore))
	}

	return true
}
