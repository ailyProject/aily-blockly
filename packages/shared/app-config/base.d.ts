/**
 * 项目数据默认路径配置
 */
export interface AppDataPathConfig {
	/** Windows 平台默认路径 */
	win32: string
	/** macOS 平台默认路径 */
	darwin: string
	/** Linux 平台默认路径 */
	linux: string
}
/**
 * 更新下载镜像策略配置
 */
export interface UpdateDownloadStrategyConfig {
	/** 是否启用镜像下载策略 */
	enabled?: boolean
	/** 镜像区域优先级顺序 */
	mirror_region_order?: Array<string>
	/** 请求失败时是否回退到其它镜像 */
	fallback_on_error?: boolean
	/** 首字节超时时间（毫秒） */
	first_byte_timeout_ms?: number
	/** 传输停滞超时时间（毫秒） */
	stall_timeout_ms?: number
}
/**
 * 编译或上传阶段的通用选项
 */
export interface BuildStepOptionsConfig {
	/** 是否输出详细日志 */
	verbose: boolean
	/** 警告处理方式 */
	warnings: string
}
/**
 * 开发模式配置
 */
export interface DevModeConfig {
	/** 是否启用开发模式 */
	enabled: boolean
	/** 是否自动保存 */
	autoSave: boolean
}
/**
 * UI 主题模式
 */
export type ThemeMode =
	/** 深色主题 */
	| 'dark'
	/** 浅色主题 */
	| 'light'
/**
 * Blockly 运行时配置
 */
export interface BlocklyConfig {
	/** Blockly 渲染器名称 */
	renderer: string
}
