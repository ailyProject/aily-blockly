/**
 * 最近项目条目
 */
export interface RecentlyProjectEntry {
	/** 项目主名称 */
	name: string
	/** 项目路径 */
	path: string
	/** 用户可见昵称 */
	nickname?: string
}

/**
 * 项目 package.json 的核心模型
 */
export interface ProjectPackageJson {
	/** npm 包名称或项目名称 */
	name?: string
	/** 用户可见昵称 */
	nickname?: string
	/** 版本号 */
	version?: string
	/** 作者信息 */
	author?: string
	/** 项目说明 */
	description?: string
	/** 云端项目 ID */
	cloudId?: string
	/** 开发模式或框架标识 */
	devmode?: ProjectDevMode
	/** 宏定义列表 */
	MACROS?: Array<string | Array<string>>
	/** 项目级配置块 */
	projectConfig?: Record<string, unknown>
	/** 运行时依赖 */
	dependencies?: Record<string, string>
	/** 开发依赖 */
	devDependencies?: Record<string, string>
	/** 可选依赖 */
	optionalDependencies?: Record<string, string>
	/** 开发板附加依赖 */
	boardDependencies?: Record<string, string>
	/** 允许透传其它 package.json 字段 */
	[key: string]: unknown
}

/**
 * 归一化后的依赖视图
 */
export interface DeclaredDependencies {
	/** 规范化后的 dependencies */
	dependencies: Record<string, string>
	/** 规范化后的 devDependencies */
	devDependencies: Record<string, string>
	/** 规范化后的 optionalDependencies */
	optionalDependencies: Record<string, string>
	/** 三类依赖合并后的总视图 */
	all: Record<string, string>
}

/**
 * 资源源配置
 */
export interface ResourceSourceConfig {
	/** 资源源唯一键 */
	key: string
	/** 资源源显示名称 */
	name?: string
	/** 资源源 URL */
	url: string
	/** 是否启用 */
	enabled?: boolean
}

/**
 * 区域配置
 */
export interface RegionConfig {
	/** 资源地址 */
	resource?: string
	/** NPM Registry 地址 */
	npm_registry?: string
	/** API 服务地址 */
	api_server?: string
	/** 工具 Web 地址 */
	tool_web?: string
	/** 是否为官方区域 */
	official?: boolean
}

/**
 * 区域配置映射
 */
export type RegionConfigMap = Record<string, RegionConfig>

/**
 * 项目开发模式
 */
export type ProjectDevMode =
	/** Arduino / C++ 工具链模式 */
	| 'arduino'
	/** MicroPython 模式 */
	| 'micropython'
	/** 其它未来扩展模式 */
	| (string & {})

/**
 * 构建风味
 */
export type BuildFlavor =
	/** 国际版构建风味 */
	| 'global'
	/** 默认/中国版构建风味 */
	| (string & {})
