import type { ChildToolHostInfo, ChildToolItem } from 'shared'

/**
 * 子工具运行时配置。
 */
export interface ChildToolRuntimeConfig extends ChildToolItem {
	/** 子工具目录名。 */
	dirName: string
	/** 子工具脚本入口。 */
	entry: string
	/** 子工具 UI 首页。 */
	uiIndex: string
	/** 启动超时。 */
	startupTimeoutMs?: number
	/** 子工具工作目录。 */
	projectPath: string
	/** 子工具脚本绝对路径。 */
	scriptPath: string
	/** 子工具 UI 绝对路径。 */
	uiPath: string
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

export type { ChildToolHostInfo, ChildToolItem }
