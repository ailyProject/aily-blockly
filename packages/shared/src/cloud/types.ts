/**
 * 云项目可见范围。
 */
export type CloudProjectScope =
	/** 公开项目列表。 */
	| 'public'
	/** 模板项目列表。 */
	| 'template'
	/** 当前登录用户的项目列表。 */
	| 'mine'

/**
 * 云项目状态动作。
 */
export type CloudProjectMutationAction =
	/** 将项目发布到公开空间。 */
	| 'publish'
	/** 更新项目基础元数据。 */
	| 'update'
	/** 取消项目的公开发布状态。 */
	| 'unpublish'
	/** 将项目标记为模板。 */
	| 'set-template'
	/** 取消项目的模板标记。 */
	| 'unset-template'
	/** 删除云端项目。 */
	| 'delete'

/**
 * 云项目可编辑元数据。
 */
export interface CloudProjectMetadata {
	/** 展示给用户的项目昵称。 */
	nickname?: string
	/** 面向云端详情页和列表的项目说明。 */
	description?: string
	/** 项目文档链接。 */
	docUrl?: string
	/** 关联的标签集合。 */
	tags?: Array<string>
}

/**
 * 云项目摘要。
 */
export interface CloudProjectSummary {
	/** 云项目唯一标识。 */
	id: string
	/** 项目主名称。 */
	name: string
	/** 用户可见昵称。 */
	nickname?: string
	/** 项目描述。 */
	description?: string
	/** 项目文档链接。 */
	docUrl?: string
	/** 已解析的封面图地址。 */
	imageUrl?: string
	/** 已解析的归档下载地址。 */
	archiveUrl?: string
	/** 板卡标识。 */
	board?: string
	/** 标签列表。 */
	tags: Array<string>
	/** 当前是否为模板。 */
	isTemplate: boolean
	/** 当前是否已公开。 */
	isPublished: boolean
}

/**
 * 云项目列表结果。
 */
export interface CloudProjectListResult {
	/** 结果作用域。 */
	scope: CloudProjectScope
	/** 当前页码。 */
	page: number
	/** 每页数量。 */
	pageSize: number
	/** 总条目数。 */
	total: number
	/** 云项目摘要列表。 */
	items: Array<CloudProjectSummary>
}

/**
 * 云项目列表查询参数。
 */
export interface CloudProjectListQuery {
	/** 需要读取的页码。 */
	page?: number
	/** 每页返回的条目数。 */
	pageSize?: number
	/** 关键字搜索；通常会匹配名称、昵称或描述。 */
	search?: string
	/** 仅筛选指定项目 ID。 */
	id?: string
	/** 仅筛选指定板卡包名。 */
	board?: string
}

/**
 * 云项目状态动作结果。
 */
export interface CloudProjectMutationResult {
	/** 当前动作是否成功。 */
	success: boolean
	/** 本次执行的动作类型。 */
	action: CloudProjectMutationAction
	/** 关联的云项目 ID。 */
	projectId: string
	/** 面向上层展示的返回消息。 */
	message: string
}

/**
 * 云项目同步结果。
 */
export interface CloudProjectSyncResult {
	/** 当前同步动作是否成功。 */
	success: boolean
	/** 云端最终归属的项目 ID。 */
	projectId: string
	/** 面向上层展示的返回消息。 */
	message: string
}
