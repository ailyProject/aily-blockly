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
 * 资源运行时环境变量载荷
 */
export interface ResourceRuntimeEnvPayload {
	/** 当前生效的单个资源地址 */
	AILY_ZIP_URL: string
	/** 候选资源地址 JSON 字符串 */
	AILY_ZIP_URLS: string
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
	/** 更新器地址 */
	updater?: string
	/** Web 站点地址 */
	web?: string
	/** 用户中心地址 */
	ucenter_web?: string
	/** 区域显示名称 */
	name?: string
	/** 是否为官方区域 */
	official?: boolean
	/** 是否启用 */
	enabled?: boolean
}
/**
 * 区域配置映射
 */
export type RegionConfigMap = Record<string, RegionConfig>
/**
 * 区域列表项
 */
export interface RegionListItem {
	/** 区域键 */
	key: string
	/** 区域名称 */
	name: string
	/** 是否启用 */
	enabled: boolean
}
/**
 * 开发板使用次数映射
 */
export type BoardUsageCountMap = Record<string, number>
/**
 * 构建风味
 */
export type BuildFlavor =
	/** 国际版构建风味 */
	| 'global'
	/** 默认/中国版构建风味 */
	| (string & {})
