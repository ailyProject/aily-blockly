/**
 * App 放置区域
 */
export type AppPlacementZone =
	/** 顶部工具栏区域 */
	'header'
/**
 * AppStore 区域配置
 */
export interface AppStoreZone {
	/** 区域唯一 ID */
	id: AppPlacementZone
	/** 区域显示名称 */
	name: string
	/** 区域图标标识 */
	icon: string
	/** 区域可放置的最大数量 */
	limit: number
}
/**
 * AppStore 布局模型
 */
export interface AppStoreLayout {
	/** 当前布局版本 */
	version: 2
	/** 各区域对应的 app id 列表 */
	zones: Record<AppPlacementZone, Array<string>>
}
/**
 * App 可见性判定上下文
 */
export interface AppVisibilityContext {
	/** 当前路由地址 */
	routeUrl?: string
	/** 当前板卡 core */
	boardCore?: string
	/** 当前是否处于开发模式 */
	isDevMode?: boolean
}
/**
 * 参与 AppStore 规则计算的最小 app 结构
 */
export interface AppRegistryItem {
	/** app 唯一 ID */
	id: string
	/** 是否启用 */
	enabled?: boolean
	/** 是否锁定在区域中 */
	lock?: boolean
	/** 仅开发模式可见 */
	dev?: boolean
	/** 允许显示的路由列表 */
	router?: Array<string>
	/** 允许显示的 board core 列表 */
	core?: Array<string>
}
