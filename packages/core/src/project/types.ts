/**
 * 从 shared 复用的项目公共类型。
 */
export type {
	BoardUsageCountMap,
	BuildFlavor,
	RecentlyProjectEntry,
	RegionConfig,
	RegionConfigMap,
	RegionListItem,
	ResourceRuntimeEnvPayload,
	ResourceSourceConfig
} from '@shared'

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
 * 项目开发模式
 */
export type ProjectDevMode =
	/** Arduino / C++ 工具链模式 */
	| 'arduino'
	/** MicroPython 模式 */
	| 'micropython'
	/** 其它未来扩展模式 */
	| (string & {})
