/**
 * desktop 宿主能力基类结果
 */
export interface DesktopHostCapabilityResult {
	/** 当前宿主能力是否可用 */
	available: boolean
	/** 能力不可用时的错误文本 */
	error?: string
}

/**
 * desktop 宿主运行时信息
 */
export interface DesktopHostRuntimeInfo extends DesktopHostCapabilityResult {
	/** Electron userData 路径 */
	appDataPath: string
	/** 当前宿主平台 */
	platform: import('@core').HardwareEsptoolPlatform
	/** child 目录路径 */
	childPath?: string
}

/**
 * desktop 根 ERPC 路由类型
 */
type RoutersFactory = (typeof import('./index'))['routers']

export type Router = RoutersFactory
