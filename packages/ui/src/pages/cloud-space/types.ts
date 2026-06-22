import type { CloudProjectScope, CloudProjectSummary } from 'shared'

/**
 * Cloud Space 页面状态。
 */
export interface CloudSpacePageState {
	/** 当前列表所属作用域。 */
	scope: CloudProjectScope
	/** 当前作用域是否要求先提供认证 token。 */
	requiresAuth: boolean
	/** 当前作用域下的项目列表。 */
	items: Array<CloudProjectSummary>
	/** 当前页码。 */
	page: number
	/** 每页数量。 */
	pageSize: number
	/** 总条目数。 */
	total: number
}

/**
 * 云项目导入动作的执行结果。
 */
export interface CloudSpaceImportResult {
	/** 本次导入是否已经成功落盘。 */
	success: boolean
	/** 面向界面的执行结果文案。 */
	message: string
	/** 成功导入后的本地项目目录。 */
	projectPath?: string
	/** 本次尝试解析出的目标目录。 */
	pendingTargetPath?: string
	/** 当前目标目录是否已存在冲突。 */
	targetPathConflict: boolean
	/** 冲突时推荐给用户的可用项目名。 */
	suggestedImportName?: string
}

/**
 * Cloud Space 项目元数据编辑草稿。
 */
export interface CloudSpaceEditorDraft {
	/** 当前正在编辑的项目 ID。 */
	projectId: string
	/** 昵称草稿。 */
	nickname: string
	/** 描述草稿。 */
	description: string
	/** 文档链接草稿。 */
	docUrl: string
	/** 逗号分隔的标签草稿。 */
	tagsText: string
	/** 当前封面预览。 */
	imagePreviewUrl: string | null
	/** 当前是否显式请求清空封面。 */
	removeCover: boolean
}

/**
 * Cloud Space 当前项目同步摘要。
 */
export interface CloudSpaceSyncSummary {
	/** 本次同步对应的本地项目路径。 */
	projectPath: string
	/** 云端最终项目 ID。 */
	projectId: string
	/** 同步归档大小，单位字节。 */
	archiveSize: number
	/** 是否把新的 cloudId 写回了本地 package.json。 */
	cloudIdUpdated: boolean
	/** 本次同步完成时间。 */
	syncedAt: string
}

/**
 * 当前本地项目与云项目的绑定摘要。
 */
export interface CloudSpaceCurrentProjectBinding {
	/** 当前本地项目路径。 */
	projectPath: string
	/** 当前绑定的云项目 ID。 */
	cloudId?: string
	/** 当前本地项目名称。 */
	name?: string
	/** 当前本地项目昵称。 */
	nickname?: string
}
