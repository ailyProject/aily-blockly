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
	/** 当前 desktop 主进程 pid */
	pid: number
	/** Electron userData 路径 */
	appDataPath: string
	/** 当前宿主的文档目录 */
	documentsPath: string
	/** 当前宿主平台 */
	platform: import('@core').HardwareEsptoolPlatform
	/** 当前宿主路径分隔符 */
	pathSeparator: string
	/** 当前桌面进程工作目录 */
	cwd: string
	/** child 目录路径 */
	childPath?: string
}

/**
 * 待打开项目路径消费结果。
 */
export interface DesktopPendingProjectOpenResult extends DesktopHostCapabilityResult {
	/** 读取并消费到的原始路径。 */
	path: string
}

/**
 * 尝试前置某个桌面进程的结果。
 */
export interface DesktopFocusProcessResult extends DesktopHostCapabilityResult {
	/** 本次前置动作是否成功。 */
	success: boolean
}

/**
 * desktop 根 ERPC 路由类型
 */
type RoutersFactory = (typeof import('./index'))['default']

export type Router = RoutersFactory
