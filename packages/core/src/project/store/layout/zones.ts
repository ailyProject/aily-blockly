import { canRegisterApp, getLockedZoneIds } from './shared'

import type { AppPlacementZone, AppRegistryItem } from 'shared'

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
