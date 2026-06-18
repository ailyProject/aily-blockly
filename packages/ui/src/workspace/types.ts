/**
 * 工作区子工具元数据
 */
export interface WorkspaceChildToolItem {
	/** 子工具唯一标识 */
	id: string
	/** 子工具显示标题 */
	title: string
	/** 子工具的用途说明 */
	summary: string
	/** 推荐的启动路径 */
	launchPath: string
}

/**
 * 工作区嵌入目标元数据
 */
export interface WorkspaceEmbedTarget {
	/** 嵌入目标唯一标识 */
	id: string
	/** 嵌入目标显示标题 */
	title: string
	/** 嵌入目标摘要说明 */
	summary: string
	/** 可直接加载的目标 URL */
	url: string
}

/**
 * 模型商店展示条目
 */
export interface WorkspaceModelCatalogItem {
	/** 模型唯一标识 */
	id: string
	/** 模型显示名称 */
	name: string
	/** 模型作者名称 */
	author: string
	/** 模型任务类型 */
	task: string
	/** 模型适配开发板 */
	board: string
	/** 模型推理框架 */
	framework: string
	/** 模型体积描述 */
	size: string
	/** 模型用途摘要 */
	summary: string
	/** 推荐部署目标 */
	deployTarget: string
	/** 模型详情链接 */
	link: string
}
