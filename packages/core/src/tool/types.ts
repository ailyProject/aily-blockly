/**
 * 子工具目录条目
 */
export interface ChildToolItem {
	/** 子工具唯一标识 */
	id: string
	/** 子工具显示标题 */
	title: string
	/** 子工具用途摘要 */
	summary: string
	/** 子工具推荐启动路径 */
	launchPath: string
}

/**
 * 子工具目录发现参数
 */
export interface ChildToolDiscoveryOptions {
	/** Aily child 根目录 */
	childPath?: string
}

/**
 * 子工具包元数据
 */
export interface ChildToolPackageJson {
	/** 子工具主入口 */
	main?: string
	/** 子工具名称 */
	name?: string
	/** 子工具描述 */
	description?: string
}
