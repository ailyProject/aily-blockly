import type { AppStoreZone } from './types'

/**
 * Header 区域允许显示的 app 数量上限
 */
export const HEADER_APP_LIMIT = 8

/**
 * AppStore 本地存储键
 */
export const APP_STORE_STORAGE_KEY = 'app-store-zones-config'

/**
 * toolbar app id 在配置文件中的存储键
 */
export const TOOLBAR_APP_IDS_CONFIG_KEY = 'toolbarAppIds'

/**
 * AppStore 默认区域定义
 */
export const APP_STORE_ZONES: Array<AppStoreZone> = [
	{
		id: 'header',
		name: 'APP_STORE.TOOLBAR_APPS',
		icon: 'fa-light fa-window-flip',
		limit: HEADER_APP_LIMIT
	}
]
