import { config, toolbarApps } from '@/workspace'

import type { Core } from '@/utils/core'
import type { AppStorePageState } from './types'

/**
 * 加载 App Store 页面状态。
 * @param core - core 服务句柄
 */
export const loadAppStorePageState = async (core: Core): Promise<AppStorePageState> => {
	const [configSummary, layoutSummary] = await Promise.all([
		core.config.get.query({ config, fallbackLanguage: config.lang }),
		core.store.resolveLayout.query({
			config,
			apps: toolbarApps,
			defaultToolbarAppIds: config.toolbarAppIds ?? [],
			context: {
				routeUrl: '/main/blockly-editor',
				boardCore: 'esp32',
				isDevMode: false
			}
		})
	])

	const pinnedIds = new Set(layoutSummary.layout.zones.header)
	const visibleIds = new Set(layoutSummary.visibleHeaderIds)

	return {
		toolbarCount: configSummary.toolbarAppIds.length,
		visibleToolbarCount: layoutSummary.visibleHeaderIds.length,
		pinnedIds: [...layoutSummary.layout.zones.header],
		apps: toolbarApps.map(app => ({
			id: app.id,
			visible: visibleIds.has(app.id),
			pinned: pinnedIds.has(app.id),
			lock: app.lock === true,
			devOnly: app.dev === true
		}))
	}
}
